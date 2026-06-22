import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import OpenAI from 'openai';
import { NoticeToMariners } from '../entities/notice-to-mariners.entity';
import { Logs } from '../../common/entities/logs.entity';
import { LogType } from '../../common/log-type';
import { errorMessage } from '../../common/utils/error-message';
import { enrichMapZone, type MapZoneEnrichment } from './map-zone-enrich';
import {
  fetchCommunityMapKml,
  parseKmlFolders,
  type KmlFolder,
  type ZoneGeometry,
} from './kml-source';
import { filterMarineGeometries } from './sea-filter';
import { DateTime } from 'luxon';
import {
  parseDistance,
  parseNoticeDate,
  parseNoticeRef,
  parseSourceUrl,
  parseValidity,
  type Validity,
} from './validity';
import {
  COMMUNITY_MAP_SOURCE,
  MAP_LAYERS,
  matchLayer,
  matchesPlacemark,
  type MapLayerDef,
} from './layers.config';

// Default map: the community "Malta Ranger Unit" My Map. Overridable via
// COMMUNITY_MAP_MID so a fork/staging run can point at a different curated map.
export const DEFAULT_COMMUNITY_MAP_MID = '12ttvcu19lSEIV8blQwx8ZYaCt14gv38';
const MIN_EXPECTED_ZONE_COUNT = 50;
const MIN_EXISTING_RETENTION_RATIO = 0.6;
const ENRICH_CONCURRENCY = 8;
const RESTRICTIONS_HEADING = 'Restrictions:';
const REVIEW_AI_ENRICHMENT_FAILED = 'community-map-ai-enrichment-failed';
const REVIEW_SOURCE_DESCRIPTION_MISSING =
  'community-map-source-description-missing';

type NoticePart = NoticeToMariners['areas'][number];

// The fields we own for a community-map row. Everything else (id, createdAt,
// updatedAt) is managed by TypeORM. needsReview stays false (the map is
// curated). activeFrom/activeTo come from the placemark's stated validity
// window (seasonal swimmer zones) or default to permanent.
type CommunityMapRow = Pick<
  NoticeToMariners,
  | 'kind'
  | 'title'
  | 'description'
  | 'source'
  | 'subKey'
  | 'locationLabel'
  | 'areas'
  | 'publishedAt'
  | 'activeFrom'
  | 'needsReview'
  | 'reviewReasons'
> & {
  // Nullable facts we derive from the placemark. Modelled as `T | null` (not the
  // entity's `T | undefined`) so the upsert explicitly clears a column when the
  // source drops a value, rather than leaving the prior one in place.
  activeTo: Date | null;
  category: string | null;
  noticeRef: string | null;
  sourceUrl: string | null;
  distance: number | null;
};

export interface SnapshotZone {
  layer: MapLayerDef;
  zoneName: string;
  subKey: string;
  geometries: ZoneGeometry[];
  sourceDescription: string;
  // The KML folder label this zone came from. Carries the establishing notice
  // reference (e.g. "… Notice to Mariners 09 & 10 of 2023") for the permanent
  // layers, whose placemark descriptions state no date. Read for the year only.
  folderName: string;
}

export interface CommunityMapSnapshot {
  zones: SnapshotZone[];
  matchedLayerKeys: Set<string>;
}

// Ingests the community map as the authoritative source of marine
// restriction-zone geometry + classification. The BullMQ processor owns retry
// behavior; errors deliberately escape this service so transient failures are
// retried instead of being delayed until the next daily run.
@Injectable()
export class CommunityMapImportService implements OnModuleInit {
  private readonly logger = new Logger(CommunityMapImportService.name);
  // Every complete zone description is AI-generated from the map's source facts
  // and rewritten rather than copied. OPENAI_API_KEY is required so construction
  // fails fast if it is unset.
  private readonly openai: OpenAI;
  private readonly enrichModel?: string;
  private readonly mid: string;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
  ) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') });
    this.enrichModel =
      config.get<string>('ENRICH_MODEL') ?? config.get<string>('OPENAI_MODEL');
    this.mid =
      config.get<string>('COMMUNITY_MAP_MID') ?? DEFAULT_COMMUNITY_MAP_MID;
    this.enabled = config.get<boolean>('COMMUNITY_MAP_IMPORT_ENABLED') ?? true;
  }

  // Validate OPENAI_API_KEY at startup so a bad/expired/forbidden key crashes
  // the process immediately instead of silently degrading the daily import.
  // The throw propagates through Nest's init phase to bootstrap()'s catch, which
  // exits the process. A lightweight models.list() is enough to exercise auth.
  // Transient/network failures are not fatal — the key is only proven *invalid*
  // by a 401/403, so we crash on those alone and merely warn on anything else.
  async onModuleInit(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.openai.models.list();
    } catch (err) {
      if (
        err instanceof OpenAI.AuthenticationError ||
        err instanceof OpenAI.PermissionDeniedError
      ) {
        throw new Error(
          `OPENAI_API_KEY rejected by OpenAI: ${errorMessage(err)}`,
        );
      }
      this.logger.warn(
        `Could not verify OPENAI_API_KEY at startup (continuing): ${errorMessage(err)}`,
      );
    }
  }

  async importCommunityMap(): Promise<void> {
    if (!this.enabled) return;
    const summary = await this.runImport();
    await this.recordLog(
      `Imported community map: ${summary.upserted} zone(s) written, ` +
        `${summary.deleted} stale removed, ${summary.kept} unchanged ` +
        `(${summary.aiCalls} AI description(s) generated)`,
    );
  }

  private async runImport() {
    const xml = await fetchCommunityMapKml(this.mid);
    const folders = parseKmlFolders(xml);
    const snapshot = buildCommunityMapSnapshot(folders);

    // Existing community-map rows, keyed by subKey: lets us reuse a zone's already
    // generated description (skip the LLM) and keep its original timestamps
    // stable, and tells us which rows went stale.
    const existing = new Map<string, NoticeToMariners>();
    for (const row of await this.noticeRepository.findBy({
      source: COMMUNITY_MAP_SOURCE,
    })) {
      existing.set(row.subKey, row);
    }
    assertSafeSnapshot(snapshot, existing.size);

    const seen = new Set<string>();
    const toWrite: CommunityMapRow[] = [];
    let aiCalls = 0;
    let kept = 0;
    let upserted = 0;
    const importedAt = new Date();
    const bootstrap = existing.size === 0;

    for (
      let offset = 0;
      offset < snapshot.zones.length;
      offset += ENRICH_CONCURRENCY
    ) {
      const batch = snapshot.zones.slice(offset, offset + ENRICH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (zone): Promise<ProcessedZone> => {
          const { layer, zoneName, subKey } = zone;
          seen.add(subKey);
          const areas = toAreas(displayZoneName(zoneName), zone.geometries);
          const prior = existing.get(subKey);

          const { fields, seasonal } = resolveZoneFacts(
            zone,
            prior,
            areas,
            importedAt,
          );

          // Reuse prior output unless a prompt fact changed, it predates the
          // structured restrictions format, its title still carries the raw
          // marker prefix (a one-time re-enrich to generate a clean AI title),
          // or an importer failure needs retrying.
          const stale =
            !prior ||
            descriptionFactsChanged(prior, fields, seasonal) ||
            !hasCurrentDescriptionFormat(prior.description) ||
            isVertexMarkerName(prior.title) ||
            prior.reviewReasons?.some((reason) =>
              reason.startsWith('community-map-'),
            );
          let description = prior?.description;
          let title = prior?.title;
          let reviewReasons = prior?.reviewReasons ?? [];
          let attemptedAi = false;
          if (!description || stale) {
            const result = await this.describe(
              layer,
              zoneName,
              zone.sourceDescription,
              {
                seasonal,
                distance: fields.distance,
                noticeRef: fields.noticeRef,
              },
              prior?.description,
            );
            description = result.description;
            title = result.title;
            reviewReasons = result.reviewReasons;
            attemptedAi = result.attemptedAi;
          }

          const row: CommunityMapRow = {
            ...fields,
            title: title ?? fields.title,
            description,
            needsReview: reviewReasons.length > 0,
            reviewReasons,
          };
          const isKept = Boolean(prior && unchanged(prior, row));
          return {
            row: isKept ? null : row,
            kept: isKept,
            attemptedAi,
          };
        }),
      );

      aiCalls += results.filter((result) => result.attemptedAi).length;
      kept += results.filter((result) => result.kept).length;
      const batchRows = results
        .map((result) => result.row)
        .filter((row): row is CommunityMapRow => row !== null);

      if (bootstrap && batchRows.length > 0) {
        // With an empty database, publish each completed batch instead of keeping
        // the map blank while every AI call finishes. Existing installations keep
        // the atomic transaction below and remain on their last approved snapshot.
        await this.noticeRepository.upsert(
          batchRows as QueryDeepPartialEntity<NoticeToMariners>[],
          ['source', 'subKey'],
        );
        upserted += batchRows.length;
      } else {
        toWrite.push(...batchRows);
      }
    }

    const stale = [...existing.keys()].filter((k) => !seen.has(k));
    await this.noticeRepository.manager.transaction(async (manager) => {
      const repository = manager.getRepository(NoticeToMariners);
      if (toWrite.length) {
        // `reports` is deliberately absent. Inserts receive the column default;
        // conflict updates preserve concurrent public increments instead of
        // writing the stale value read before description generation began.
        // The column is nullable, but TypeORM's payload type models activeTo as
        // Date | undefined. Null deliberately clears a removed end date.
        await repository.upsert(
          toWrite as QueryDeepPartialEntity<NoticeToMariners>[],
          ['source', 'subKey'],
        );
        upserted += toWrite.length;
      }
      if (stale.length) {
        await repository
          .createQueryBuilder()
          .delete()
          .from(NoticeToMariners)
          .where('source = :source', { source: COMMUNITY_MAP_SOURCE })
          .andWhere('"subKey" IN (:...keys)', { keys: stale })
          .execute();
      }
    });

    return {
      upserted,
      deleted: stale.length,
      kept,
      aiCalls,
    };
  }

  // Extract the map's source facts into original wording. The source prose is
  // sent to the model as untrusted input but is never stored. Failures retain the
  // previous description (or our brief for a new row) and send the row to review.
  private async describe(
    layer: MapLayerDef,
    zoneName: string,
    sourceDescription: string,
    facts: PromptFacts,
    priorDescription?: string,
  ): Promise<DescriptionResult> {
    const place = displayZoneName(zoneName);
    const sourceText = plainSourceText(sourceDescription);
    if (!sourceText) {
      return {
        title: place,
        description: usablePriorDescription(priorDescription)
          ? priorDescription
          : fallbackDescription(layer),
        reviewReasons: [REVIEW_SOURCE_DESCRIPTION_MISSING],
        attemptedAi: false,
      };
    }
    try {
      const e = await enrichMapZone(
        this.openai,
        {
          category: layer.key.replace(/-/g, ' '),
          zoneName: place,
          restrictionBrief: layer.restrictionBrief,
          sourceText,
          facts: factLines(facts),
        },
        this.enrichModel,
      );
      return {
        title: e.title,
        description: composeDescription(e),
        reviewReasons: [],
        attemptedAi: true,
      };
    } catch (err) {
      // A bad/expired/forbidden API key fails every zone, not just this one.
      // Don't swallow it as a per-zone fallback: re-throw so the import aborts
      // and the BullMQ processor surfaces the failure instead of silently
      // marking every zone for review.
      if (
        err instanceof OpenAI.AuthenticationError ||
        err instanceof OpenAI.PermissionDeniedError
      ) {
        throw err;
      }
      this.logger.warn(
        `Map-zone description fell back for "${zoneName}": ${errorMessage(err)}`,
      );
      return {
        title: place,
        description: usablePriorDescription(priorDescription)
          ? priorDescription
          : fallbackDescription(layer),
        reviewReasons: [REVIEW_AI_ENRICHMENT_FAILED],
        attemptedAi: true,
      };
    }
  }

  private async recordLog(description: string) {
    this.logger.log(description);
    const log = this.logsRepository.create({
      logType: LogType.IMPORT_JOB,
      description,
    });
    await this.logsRepository.save(log);
  }
}

// The fact fields a community-map row stores, before its (AI) description is
// attached. Carried alongside `seasonal` — the parsed validity window — which
// the prompt and staleness check need but the row doesn't store.
type CommunityMapFields = Omit<CommunityMapRow, 'description'>;

// The subset of facts that feed the LLM prompt (and so decide whether a reused
// description has gone stale).
interface PromptFacts {
  seasonal: Validity;
  distance: number | null;
  noticeRef: string | null;
}

interface DescriptionResult {
  title: string;
  description: string;
  reviewReasons: string[];
  attemptedAi: boolean;
}

interface ProcessedZone {
  row: CommunityMapRow | null;
  kept: boolean;
  attemptedAi: boolean;
}

function resolveZoneFacts(
  zone: SnapshotZone,
  prior: NoticeToMariners | undefined,
  areas: NoticePart[],
  importedAt: Date,
): { fields: CommunityMapFields; seasonal: Validity } {
  const seasonal = parseValidity(zone.sourceDescription);
  // activeFrom precedence: a date stated in the notice prose, else the year of
  // the establishing notice (standing "all year round" zones — their date is
  // the notice reference in the description or folder label), else a prior
  // value, and only as a last resort the scrape time. The notice date precedes
  // `prior` deliberately: it corrects rows imported before this fallback existed
  // (which carry a meaningless scrape-day activeFrom) instead of pinning them.
  const noticeDate =
    parseNoticeDate(zone.sourceDescription) ?? parseNoticeDate(zone.folderName);
  const activeFrom =
    seasonal.from ?? noticeDate ?? prior?.activeFrom ?? importedAt;
  // The notice reference lives in the description (swimmer zones) or only in the
  // folder label (permanent layers); the URL and distance are description-only.
  return {
    seasonal,
    fields: {
      kind: zone.layer.kind,
      // Deterministic display baseline: the place name with the marker prefix
      // stripped. The AI rewrite (when it runs) overrides `title` in the import
      // loop; this value stands in when enrichment is skipped or falls back.
      title: displayZoneName(zone.zoneName),
      source: COMMUNITY_MAP_SOURCE,
      subKey: zone.subKey,
      locationLabel: displayZoneName(zone.zoneName),
      category: zone.layer.key,
      noticeRef:
        parseNoticeRef(zone.sourceDescription) ??
        parseNoticeRef(zone.folderName),
      sourceUrl: parseSourceUrl(zone.sourceDescription),
      distance: parseDistance(zone.sourceDescription),
      areas,
      publishedAt: prior?.publishedAt ?? activeFrom,
      activeFrom,
      activeTo: seasonal.to ?? null,
      needsReview: prior?.needsReview ?? false,
      reviewReasons: prior?.reviewReasons ?? [],
    },
  };
}

// The notice-year fallback (Jan 1) is not a real start date, so we only state a
// validity period to the model when the prose gave a genuine seasonal window.
function fmtDate(date: Date): string {
  return DateTime.fromJSDate(date, { zone: 'utc' }).toFormat('d LLLL yyyy');
}

function factLines({ seasonal, distance, noticeRef }: PromptFacts): string[] {
  const lines: string[] = [];
  if (distance != null) {
    lines.push(`Vessels must keep at least ${distance} m clear.`);
  }
  if (seasonal.from) {
    lines.push(
      seasonal.to
        ? `In force from ${fmtDate(seasonal.from)} until ${fmtDate(seasonal.to)}.`
        : `In force from ${fmtDate(seasonal.from)}.`,
    );
  }
  if (noticeRef) lines.push(`Established by ${noticeRef}.`);
  return lines;
}

// Whether a reused description would misstate the zone: any prompt input — place
// name, class, clearance distance, governing notice, or the seasonal window —
// differs from what the prior row was generated against.
function descriptionFactsChanged(
  prior: NoticeToMariners,
  fields: CommunityMapFields,
  seasonal: Validity,
): boolean {
  return (
    prior.title !== fields.title ||
    (prior.category ?? null) !== fields.category ||
    (prior.distance ?? null) !== fields.distance ||
    (prior.noticeRef ?? null) !== fields.noticeRef ||
    !sameInstant(prior.activeTo, fields.activeTo) ||
    (seasonal.from
      ? prior.activeFrom.getTime() !== seasonal.from.getTime()
      : false)
  );
}

export function buildCommunityMapSnapshot(
  folders: KmlFolder[],
): CommunityMapSnapshot {
  const matchedLayerKeys = new Set<string>();
  const groups = new Map<
    string,
    {
      layer: MapLayerDef;
      zoneName: string;
      sourceDescription: string;
      folderName: string;
      geometries: Map<string, ZoneGeometry>;
    }
  >();

  for (const folder of folders) {
    const layer = matchLayer(folder.name);
    if (!layer) continue;

    for (const placemark of folder.placemarks) {
      const zoneName = normalizeZoneName(placemark.name || folder.name);
      if (!matchesPlacemark(layer, zoneName)) continue;

      const marine = filterMarineGeometries(
        importableGeometries(layer, zoneName, placemark.geometries),
      );
      if (marine.length === 0) continue;
      matchedLayerKeys.add(layer.key);

      const groupKey = `${layer.key}:${normalizedIdentity(zoneName)}`;
      const group = groups.get(groupKey) ?? {
        layer,
        zoneName,
        sourceDescription: placemark.description,
        folderName: folder.name,
        geometries: new Map<string, ZoneGeometry>(),
      };
      if (!group.sourceDescription && placemark.description) {
        group.sourceDescription = placemark.description;
      }
      for (const geometry of marine) {
        group.geometries.set(geometryFingerprint(geometry), geometry);
      }
      groups.set(groupKey, group);
    }
  }

  const zones = [...groups.values()]
    .map(
      (group): SnapshotZone => ({
        layer: group.layer,
        zoneName: group.zoneName,
        subKey: stableZoneSubKey(group.layer.key, group.zoneName),
        geometries: [...group.geometries.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, geometry]) => geometry),
        sourceDescription: group.sourceDescription,
        folderName: group.folderName,
      }),
    )
    .sort((a, b) => a.subKey.localeCompare(b.subKey));

  return { zones, matchedLayerKeys };
}

export function assertSafeSnapshot(
  snapshot: CommunityMapSnapshot,
  existingCount: number,
): void {
  const missingLayers = MAP_LAYERS.map((layer) => layer.key).filter(
    (key) => !snapshot.matchedLayerKeys.has(key),
  );
  if (missingLayers.length > 0) {
    throw new Error(
      `Community-map snapshot is missing configured layers: ${missingLayers.join(', ')}`,
    );
  }
  if (snapshot.zones.length < MIN_EXPECTED_ZONE_COUNT) {
    throw new Error(
      `Community-map snapshot has only ${snapshot.zones.length} zones; expected at least ${MIN_EXPECTED_ZONE_COUNT}`,
    );
  }
  if (
    existingCount > 0 &&
    snapshot.zones.length < existingCount * MIN_EXISTING_RETENTION_RATIO
  ) {
    throw new Error(
      `Community-map snapshot shrank from ${existingCount} to ${snapshot.zones.length} zones; refusing destructive sync`,
    );
  }
}

export function stableZoneSubKey(layerKey: string, zoneName: string): string {
  const digest = createHash('sha256')
    .update(normalizedIdentity(zoneName))
    .digest('hex')
    .slice(0, 20);
  return `${layerKey}:${digest}`;
}

export function geometryFingerprint(geometry: ZoneGeometry): string {
  return createHash('sha256').update(canonicalGeometry(geometry)).digest('hex');
}

function normalizeZoneName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizedIdentity(name: string): string {
  return normalizeZoneName(name).toLocaleLowerCase('en');
}

// The curated map's placemark labels carry a marker prefix like "(41)" or "(H)"
// that disambiguates vertices in Google My Maps but means nothing to a mariner.
// Strip it for anything shown to users; identity/dedup keeps keying off the full
// normalized name (via `normalizedIdentity`) so "(41) Marsaxlokk" and
// "(42) Marsaxlokk" stay distinct rows even when their display names collide.
function displayZoneName(name: string): string {
  const stripped = name.replace(/^\([^)]{1,8}\)\s*/, '').trim();
  return stripped.length > 0 ? stripped : name;
}

function importableGeometries(
  layer: MapLayerDef,
  placemarkName: string,
  geometries: ZoneGeometry[],
): ZoneGeometry[] {
  const includePoint =
    layer.includeNamedPoints === true && !isVertexMarkerName(placemarkName);
  return geometries.filter(
    (geometry) => geometry.type !== 'point' || includePoint,
  );
}

function isVertexMarkerName(name: string): boolean {
  return /^\([^)]{1,8}\)\s*/.test(name);
}

function canonicalGeometry(geometry: ZoneGeometry): string {
  const points = geometry.points.map(
    ([longitude, latitude]) => `${longitude.toFixed(7)},${latitude.toFixed(7)}`,
  );
  if (geometry.type === 'point') return `point:${points[0] ?? ''}`;

  if (geometry.type === 'line') {
    const forward = points.join(';');
    const reverse = [...points].reverse().join(';');
    return `line:${forward < reverse ? forward : reverse}`;
  }

  const ring = [...points];
  if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
  const forward = smallestRotation(ring);
  const reverse = smallestRotation([...ring].reverse());
  return `polygon:${forward < reverse ? forward : reverse}`;
}

function smallestRotation(points: string[]): string {
  if (points.length === 0) return '';
  let smallest = points.join(';');
  for (let index = 1; index < points.length; index += 1) {
    const candidate = [...points.slice(index), ...points.slice(0, index)].join(
      ';',
    );
    if (candidate < smallest) smallest = candidate;
  }
  return smallest;
}

function toAreas(label: string, geoms: ZoneGeometry[]): NoticePart[] {
  return geoms.map((g) => ({
    label,
    geometryType: g.type,
    points: g.points.map(([long, lat]) => ({ lat, long })),
  }));
}

function composeDescription(e: MapZoneEnrichment): string {
  const restrictions = e.restrictions
    .map((restriction) => restriction.trim())
    .filter(Boolean)
    .map((restriction) => `- ${restriction}`)
    .join('\n');
  return [e.summary, `${RESTRICTIONS_HEADING}\n${restrictions}`]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}

function fallbackDescription(layer: MapLayerDef): string {
  return layer.restrictionBrief;
}

function usablePriorDescription(
  description: string | undefined,
): description is string {
  return Boolean(
    description &&
    !description.includes('Source details require manual verification.'),
  );
}

function hasCurrentDescriptionFormat(description: string): boolean {
  return (
    description.includes(`\n\n${RESTRICTIONS_HEADING}\n`) &&
    !description.includes('\n\nRecommended action:')
  );
}

function plainSourceText(description: string): string {
  return description
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A prior row equals a freshly built one when nothing a client sees changed —
// classification, title, description, geometry and the validity window. Standing
// zones resolve to a deterministic notice-year activeFrom (or, lacking any date,
// the carried-forward prior value), so a re-import is a no-op once corrected; a
// parsed seasonal date that moves still triggers a write.
function unchanged(prior: NoticeToMariners, next: CommunityMapRow): boolean {
  return (
    prior.kind === next.kind &&
    prior.title === next.title &&
    prior.description === next.description &&
    prior.activeFrom.getTime() === next.activeFrom.getTime() &&
    sameInstant(prior.activeTo, next.activeTo) &&
    (prior.category ?? null) === next.category &&
    (prior.noticeRef ?? null) === next.noticeRef &&
    (prior.sourceUrl ?? null) === next.sourceUrl &&
    (prior.distance ?? null) === next.distance &&
    prior.needsReview === next.needsReview &&
    JSON.stringify(prior.reviewReasons ?? []) ===
      JSON.stringify(next.reviewReasons) &&
    JSON.stringify(prior.areas) === JSON.stringify(next.areas)
  );
}

function sameInstant(
  a: Date | null | undefined,
  b: Date | null | undefined,
): boolean {
  const at = a ? a.getTime() : null;
  const bt = b ? b.getTime() : null;
  return at === bt;
}
