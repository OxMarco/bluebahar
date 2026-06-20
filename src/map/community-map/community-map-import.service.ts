import { Injectable, Logger } from '@nestjs/common';
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
import { parseValidity } from './validity';
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
> & { activeTo: Date | null };

export interface SnapshotZone {
  layer: MapLayerDef;
  zoneName: string;
  subKey: string;
  geometries: ZoneGeometry[];
  sourceDescription: string;
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
export class CommunityMapImportService {
  private readonly logger = new Logger(CommunityMapImportService.name);
  // Optional: when AI descriptions are off (or no key is set) the import still
  // runs, falling back to the self-authored restriction brief. Keeps local
  // testing cheap and key-free (set COMMUNITY_MAP_DESCRIBE_WITH_AI=false).
  private readonly openai: OpenAI | null;
  private readonly aiDescribe: boolean;
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
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.aiDescribe =
      config.get<boolean>('COMMUNITY_MAP_DESCRIBE_WITH_AI') ?? true;
    this.enrichModel =
      config.get<string>('ENRICH_MODEL') ?? config.get<string>('OPENAI_MODEL');
    this.mid =
      config.get<string>('COMMUNITY_MAP_MID') ?? DEFAULT_COMMUNITY_MAP_MID;
    this.enabled = config.get<boolean>('COMMUNITY_MAP_IMPORT_ENABLED') ?? true;
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
    const importedAt = new Date();

    for (const zone of snapshot.zones) {
      const { layer, zoneName, subKey } = zone;
      seen.add(subKey);
      const areas = toAreas(zoneName, zone.geometries);
      const prior = existing.get(subKey);

      // Reuse the prior description when the zone's identity is unchanged so we
      // don't re-bill the LLM on every daily run.
      let description = prior?.description;
      if (!description) {
        description = await this.describe(layer, zoneName);
        if (this.aiDescribe && this.openai) aiCalls += 1;
      }

      const row = buildCommunityMapRow(
        zone,
        prior,
        areas,
        description,
        importedAt,
      );

      if (prior && unchanged(prior, row)) {
        kept += 1;
        continue;
      }
      toWrite.push(row);
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
      upserted: toWrite.length,
      deleted: stale.length,
      kept,
      aiCalls,
    };
  }

  // Generate our own description; never feed or store the map's copyrighted
  // prose. On LLM failure fall back to the (self-authored) restriction brief so
  // a zone still gets a usable, original description.
  private async describe(
    layer: MapLayerDef,
    zoneName: string,
  ): Promise<string> {
    // No key / AI disabled: use the self-authored brief verbatim — still
    // original text, never the map's prose.
    const client = this.openai;
    if (!this.aiDescribe || !client) return layer.restrictionBrief;
    try {
      const e = await enrichMapZone(
        client,
        {
          category: layer.key.replace(/-/g, ' '),
          zoneName,
          restrictionBrief: layer.restrictionBrief,
        },
        this.enrichModel,
      );
      return composeDescription(e) || layer.restrictionBrief;
    } catch (err) {
      this.logger.warn(
        `Map-zone description fell back for "${zoneName}": ${errorMessage(err)}`,
      );
      return layer.restrictionBrief;
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

function buildCommunityMapRow(
  zone: SnapshotZone,
  prior: NoticeToMariners | undefined,
  areas: NoticePart[],
  description: string,
  importedAt: Date,
): CommunityMapRow {
  const active = parseValidity(zone.sourceDescription);
  const activeFrom = active.from ?? prior?.activeFrom ?? importedAt;
  return {
    kind: zone.layer.kind,
    title: zone.zoneName,
    description,
    source: COMMUNITY_MAP_SOURCE,
    subKey: zone.subKey,
    locationLabel: zone.zoneName,
    areas,
    publishedAt: prior?.publishedAt ?? activeFrom,
    activeFrom,
    activeTo: active.to ?? null,
    needsReview: false,
    reviewReasons: [],
  };
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
        placemark.geometries.filter((geometry) => geometry.type !== 'point'),
      );
      if (marine.length === 0) continue;
      matchedLayerKeys.add(layer.key);

      const groupKey = `${layer.key}:${normalizedIdentity(zoneName)}`;
      const group = groups.get(groupKey) ?? {
        layer,
        zoneName,
        sourceDescription: placemark.description,
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
  return [e.summary, e.recommended_action]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}

// A prior row equals a freshly built one when nothing a client sees changed —
// classification, title, description, geometry and the validity window. (Undated
// zones carry the prior activeFrom forward, so it never triggers a write on its
// own; a parsed seasonal date that moves does.)
function unchanged(prior: NoticeToMariners, next: CommunityMapRow): boolean {
  return (
    prior.kind === next.kind &&
    prior.title === next.title &&
    prior.description === next.description &&
    prior.activeFrom.getTime() === next.activeFrom.getTime() &&
    sameInstant(prior.activeTo, next.activeTo) &&
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
