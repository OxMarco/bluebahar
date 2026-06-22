import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import * as Sentry from '@sentry/nestjs';
import { bbox as turfBbox } from '@turf/bbox';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { errorMessage } from '../common/utils/error-message';
import {
  DATASETS,
  DEFAULT_DATASET_BOUNDS,
  type DatasetAttribution,
  type DatasetBounds,
  type DatasetDefinition,
  type DatasetKind,
} from './datasets';
import { ADAPTERS, applyBeachClassification } from './normalize/adapters';
import type { NormalizedFeatureProperties } from './normalize/normalized-feature';
import {
  normalizeSiteCode,
  type BeachClassification,
} from './bathing-classification/classification';
import { isRingClosed } from './geo-ring';

const BEACHES_KEY = 'beaches';

// GeoJSON files are committed to the repo and shipped with the deploy artifact;
// resolved from process.cwd() since both `npm start` and the Dockerfile's
// WORKDIR /app put us at the project root.
const DATASETS_DIR = resolve(process.cwd(), 'data/datasets');

type GeoJsonBbox = [number, number, number, number];

export interface DatasetMetadata {
  key: string;
  name: string;
  kind: DatasetKind;
  sourceUrl: string;
  attribution?: DatasetAttribution;
  featureCount: number;
  geometryTypes: string[];
  bbox?: GeoJsonBbox;
  byteSize: number;
  sha256: string;
}

export interface DatasetEntry {
  metadata: DatasetMetadata;
  // Pre-serialized GeoJSON FeatureCollection. For interactive datasets this is
  // the post-normalization payload (upstream INSPIRE noise stripped, properties
  // re-shaped to NormalizedFeatureProperties). For context datasets it's the
  // raw file contents. Served directly via res.send to keep request-time cost
  // to a string write.
  payload: string;
}

export interface DatasetCatalogStatus {
  configured: number;
  loaded: number;
  unavailable: { key: string; reason: string }[];
  datasets: {
    key: string;
    kind: DatasetKind;
    featureCount: number;
    geometryTypes: string[];
    bbox?: GeoJsonBbox;
    sha256: string;
  }[];
}

interface GeoJsonSummary {
  featureCount: number;
  geometryTypes: string[];
  bbox: GeoJsonBbox;
}

interface GeoJsonFeature {
  type: 'Feature';
  id?: string;
  bbox?: GeoJsonBbox;
  geometry: unknown;
  properties: Record<string, unknown> | NormalizedFeatureProperties | null;
}

interface GeoJsonFeatureCollection {
  type: string;
  bbox?: GeoJsonBbox;
  features: GeoJsonFeature[];
}

@Injectable()
export class DatasetCatalogService implements OnModuleInit {
  private readonly logger = new Logger(DatasetCatalogService.name);
  private readonly entries = new Map<string, DatasetEntry>();
  private readonly loadFailures = new Map<string, string>();
  // EU water-quality classification per bathing-site code, merged onto beach
  // features at build time. Owned here so EVERY beaches build (boot seed, daily
  // ArcGIS refresh, or a classification update) merges the current map — the
  // bathing-classification importer pushes it via setBeachClassifications().
  private beachClassifications = new Map<string, BeachClassification>();
  // The last raw beaches GeoJSON, retained so a classification update can rebuild
  // the beaches entry without re-fetching ArcGIS.
  private beachesRaw?: string;
  // Site_Codes present in the current beaches entry, for the importer's
  // overlap safety rail.
  private beachSiteCodesSet = new Set<string>();

  // OnModuleInit (not OnApplicationBootstrap) on purpose: Nest completes every
  // onModuleInit hook app-wide before any onApplicationBootstrap runs, which
  // is what guarantees DatasetRefreshService's bootstrap refresh can't race
  // the seed load (hooks of the same kind within a module run concurrently).
  async onModuleInit() {
    this.entries.clear();
    this.loadFailures.clear();

    for (const def of DATASETS) {
      const filePath = resolve(DATASETS_DIR, `${def.key}.geojson`);
      try {
        const entry = await this.loadEntry(def, filePath);
        this.entries.set(def.key, entry);
      } catch (err) {
        const message = errorMessage(err);
        this.loadFailures.set(def.key, message);
        // A missing or malformed file shouldn't crash the whole app — the
        // notices endpoints stay useful even if a dataset is misconfigured.
        // Log + skip; the corresponding GET will 503.
        this.logger.error(
          `Failed to load dataset "${def.key}" from ${filePath}: ${message}`,
        );
        Sentry.captureException(err, {
          tags: { dataset: def.key, phase: 'dataset-bootstrap' },
          extra: { filePath },
        });
      }
    }
    this.logger.log(
      `Loaded ${this.entries.size}/${DATASETS.length} dataset(s) from ${DATASETS_DIR}`,
    );
  }

  list(): DatasetMetadata[] {
    return [...this.entries.values()]
      .map((e) => e.metadata)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // A single opaque token that changes whenever any served layer's content
  // changes (sha256), a layer is added, or one drops out at boot. The app polls
  // this via the cache manifest and re-fetches the dataset list (which carries
  // the per-layer sha256s its own eviction keys off) only when it moves.
  revision(): string {
    const parts = [...this.entries.values()]
      .map((e) => `${e.metadata.key}:${e.metadata.sha256}`)
      .sort();
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  status(): DatasetCatalogStatus {
    return {
      configured: DATASETS.length,
      loaded: this.entries.size,
      unavailable: [...this.loadFailures.entries()]
        .map(([key, reason]) => ({ key, reason }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      datasets: [...this.entries.values()]
        .map((entry) => ({
          key: entry.metadata.key,
          kind: entry.metadata.kind,
          featureCount: entry.metadata.featureCount,
          geometryTypes: entry.metadata.geometryTypes,
          bbox: entry.metadata.bbox,
          sha256: entry.metadata.sha256,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  healthCheck(): HealthIndicatorResult {
    const status = this.status();
    // A failed optional overlay must NOT pull the instance out of rotation:
    // readiness gates on this, restarts can't fix a bad seed file, and the
    // notices endpoints stay useful regardless. Report down only when nothing
    // loaded at all; partial failures surface via unavailableCount, the
    // diagnostics endpoint, and the per-dataset Sentry alerts.
    return {
      dataset_catalog: {
        status: status.loaded > 0 || status.configured === 0 ? 'up' : 'down',
        loaded: status.loaded,
        configured: status.configured,
        unavailableCount: status.unavailable.length,
      },
    };
  }

  // Resolves to a usable entry or throws an HTTP-typed exception. Splits
  // "unknown key" (404) from "definition exists but failed to load at boot"
  // (503) so callers can tell a typo from a server-side problem.
  requireEntry(key: string): DatasetEntry {
    const entry = this.entries.get(key);
    if (entry) return entry;
    if (DATASETS.some((d) => d.key === key)) {
      throw new ServiceUnavailableException(
        `Dataset "${key}" is unavailable; check server logs.`,
      );
    }
    throw new NotFoundException(`Unknown dataset: ${key}`);
  }

  // Swaps the in-memory entry for `def.key` with one built from freshly fetched
  // GeoJSON. Used by DatasetRefreshService for the `refresh: 'daily'` layers.
  // Builds first and only commits on success, so a malformed upstream payload
  // leaves the previously-served entry (the boot-time seed) untouched. Returns
  // the new metadata so the caller can log what changed.
  refreshEntry(def: DatasetDefinition, raw: string): DatasetMetadata {
    const entry = this.buildEntry(def, raw);
    const previousCount = this.entries.get(def.key)?.metadata.featureCount;
    const absoluteMinimum = def.minRefreshFeatureCount ?? 1;
    const retentionMinimum =
      previousCount && def.minRefreshRetentionRatio != null
        ? Math.ceil(previousCount * def.minRefreshRetentionRatio)
        : 0;
    const minimum = Math.max(absoluteMinimum, retentionMinimum);
    if (entry.metadata.featureCount < minimum) {
      throw new Error(
        `Dataset "${def.key}" refresh produced ${entry.metadata.featureCount} feature(s); ` +
          `minimum safe count is ${minimum}`,
      );
    }
    this.entries.set(def.key, entry);
    this.loadFailures.delete(def.key);
    return entry.metadata;
  }

  // The Site_Codes carried by the current beaches entry. Used by the
  // bathing-classification importer to reject a report whose codes don't overlap
  // the layer (a sign the wrong PDF was parsed).
  beachSiteCodes(): ReadonlySet<string> {
    return this.beachSiteCodesSet;
  }

  // Replace the bathing-water classifications merged onto beach features and
  // rebuild the beaches entry in place. Called by the importer after a report
  // import (or on boot from persisted rows). The rebuild changes the entry's
  // sha256, so revision()/the manifest move and clients re-fetch. A build error
  // (e.g. transient) leaves the previous entry serving — never blanks the layer.
  setBeachClassifications(classifications: Map<string, BeachClassification>): {
    rebuilt: boolean;
    merged: number;
  } {
    this.beachClassifications = classifications;
    if (this.beachesRaw === undefined) return { rebuilt: false, merged: 0 };
    const def = DATASETS.find((d) => d.key === BEACHES_KEY);
    if (!def) return { rebuilt: false, merged: 0 };
    try {
      const entry = this.buildEntry(def, this.beachesRaw);
      this.entries.set(BEACHES_KEY, entry);
      this.loadFailures.delete(BEACHES_KEY);
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`Failed to apply beach classifications: ${message}`);
      Sentry.captureException(err, {
        tags: { dataset: BEACHES_KEY, phase: 'classification-merge' },
      });
      return { rebuilt: false, merged: 0 };
    }
    // Count how many merged onto an actual site present in the layer.
    let merged = 0;
    for (const code of classifications.keys()) {
      if (this.beachSiteCodesSet.has(code)) merged += 1;
    }
    return { rebuilt: true, merged };
  }

  private async loadEntry(
    def: DatasetDefinition,
    filePath: string,
  ): Promise<DatasetEntry> {
    const raw = await readFile(filePath, 'utf8');
    return this.buildEntry(def, raw);
  }

  private buildEntry(def: DatasetDefinition, raw: string): DatasetEntry {
    const parsed = JSON.parse(raw) as unknown;

    // Retain beaches raw so a classification update can rebuild the merged entry
    // without re-fetching ArcGIS. Captured before normalize() so even a build
    // that later throws leaves the raw available for the next attempt.
    if (def.key === BEACHES_KEY) this.beachesRaw = raw;

    // Interactive datasets rebuild their payload from normalized features, so
    // normalize() owns validation and drops unrenderable features (null or
    // invalid geometry, missing title) individually — one bad upstream feature
    // must not fail a whole layer or pin a daily-refreshed one to its boot
    // seed. Context datasets are served verbatim, so every feature must pass
    // up front and any invalid one rejects the dataset.
    const { payload, summary } =
      def.kind === 'interactive'
        ? this.normalize(def, parsed)
        : {
            payload: raw,
            summary: validateFeatureCollection(def, parsed),
          };

    return {
      payload,
      metadata: {
        key: def.key,
        name: def.name,
        kind: def.kind,
        sourceUrl: def.sourceUrl,
        ...(def.attribution ? { attribution: def.attribution } : {}),
        featureCount: summary.featureCount,
        geometryTypes: summary.geometryTypes,
        bbox: summary.bbox,
        byteSize: Buffer.byteLength(payload, 'utf8'),
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
    };
  }

  private normalize(
    def: DatasetDefinition,
    parsed: unknown,
  ): { payload: string; summary: GeoJsonSummary } {
    const adapter = ADAPTERS[def.key];
    if (!adapter) {
      // An interactive dataset without an adapter is a configuration bug, not a
      // runtime fallback path — fail loudly at boot so it doesn't ship.
      throw new Error(
        `Interactive dataset "${def.key}" has no adapter registered`,
      );
    }
    assertFeatureCollection(parsed);

    const geometry = geometrySchema(boundsFor(def));
    const out: GeoJsonFeature[] = [];
    let droppedNoTitle = 0;
    let droppedNoGeometry = 0;
    let droppedInvalidGeometry = 0;
    const types = new Set<string>();
    let collectionBbox: GeoJsonBbox | undefined;
    const seenIds = new Set<string>();
    const beachCodes = def.key === BEACHES_KEY ? new Set<string>() : undefined;
    for (const [index, feature] of parsed.features.entries()) {
      // Upstream feature services return rows without a mapped location as
      // null-geometry features; they can't be plotted, so skip them rather
      // than fail the layer.
      if (!isRecord(feature.geometry)) {
        droppedNoGeometry += 1;
        continue;
      }
      // Same policy for invalid geometry (e.g. an ArcGIS row emitting an
      // out-of-bounds (0, 0) point): drop the feature, keep the layer.
      const geomResult = geometry.safeParse(feature.geometry);
      if (!geomResult.success) {
        droppedInvalidGeometry += 1;
        continue;
      }
      const rawProps = (feature.properties ?? {}) as Record<string, unknown>;
      const normalized = adapter(rawProps);
      if (normalized === null) {
        droppedNoTitle += 1;
        continue;
      }
      // Merge the EU water-quality classification onto beach features, keyed by
      // the same Site_Code the report uses. The site code is also collected for
      // the importer's overlap rail.
      let enriched = normalized;
      if (beachCodes) {
        const code = beachSiteCode(rawProps);
        if (code) {
          beachCodes.add(code);
          enriched = applyBeachClassification(
            normalized,
            this.beachClassifications.get(code),
          );
        }
      }
      const id = featureId(def.key, enriched, rawProps, index, seenIds);
      const bbox = geoJsonBbox(feature.geometry);
      types.add(geomResult.data.type);
      if (bbox) collectionBbox = foldBbox(collectionBbox, bbox);
      out.push({
        type: 'Feature',
        id,
        ...(bbox ? { bbox } : {}),
        geometry: feature.geometry,
        properties: { ...enriched, id, ...stylingPrimitives(enriched) },
      });
    }
    if (beachCodes) this.beachSiteCodesSet = beachCodes;
    const dropped = droppedNoTitle + droppedNoGeometry + droppedInvalidGeometry;
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped}/${parsed.features.length} feature(s) from "${def.key}" (${droppedNoTitle} missing title, ${droppedNoGeometry} null geometry, ${droppedInvalidGeometry} invalid geometry)`,
      );
    }
    if (out.length === 0 || !collectionBbox) {
      throw new Error(
        `Dataset "${def.key}" produced no features after normalization (${dropped}/${parsed.features.length} dropped)`,
      );
    }
    // Geometry was validated feature-by-feature above and the collection bbox
    // folded from the per-feature ones, so no second pass over all
    // coordinates (summarizeFeatures) is needed here.
    const summary: GeoJsonSummary = {
      featureCount: out.length,
      geometryTypes: [...types].sort((a, b) => a.localeCompare(b)),
      bbox: collectionBbox,
    };
    const payload = JSON.stringify({
      type: 'FeatureCollection',
      bbox: summary.bbox,
      features: out,
    });
    return { payload, summary };
  }
}

// Mapbox/MapLibre (and so rnmapbox/maps) can only read primitive feature
// properties in data-driven style expressions, and the native bridge stringifies
// nested objects on the way to the app. We keep the nested fields — the client
// JSON.parses them for the detail sheet — but also surface the few worth styling
// on (rating, tags) as flat primitives a `['get', …]` expression can use.
function stylingPrimitives(
  normalized: Omit<NormalizedFeatureProperties, 'id'>,
): Record<string, string | number> {
  const flat: Record<string, string | number> = {};
  if (normalized.rating) {
    flat.ratingValue = normalized.rating.value;
    flat.ratingCount = normalized.rating.count;
  }
  if (normalized.tags?.length) {
    // Comma-wrapped so a tag membership test is a clean substring match:
    // ['in', ',Blue Flag,', ['get', 'tagsCsv']].
    flat.tagsCsv = `,${normalized.tags.join(',')},`;
  }
  if (normalized.waterQuality) {
    // Surfaced flat so a beach layer can colour pins by class
    // (['get','waterQualityValue']) or scale by the 0–4 quality rank.
    flat.waterQualityValue = normalized.waterQuality.value;
    flat.waterQualityRank = normalized.waterQuality.rank;
  }
  return flat;
}

// The canonical Site_Code (A01…D23) for a beaches feature, or undefined when
// the upstream row carries none. Used to join the EHD classification report.
function beachSiteCode(rawProps: Record<string, unknown>): string | undefined {
  const raw =
    typeof rawProps.Site_Code === 'string' ? rawProps.Site_Code.trim() : '';
  return raw ? normalizeSiteCode(raw) : undefined;
}

function validateFeatureCollection(
  def: DatasetDefinition,
  value: unknown,
): GeoJsonSummary {
  assertFeatureCollection(value);
  return summarizeFeatures(def, value.features);
}

function assertFeatureCollection(
  value: unknown,
): asserts value is GeoJsonFeatureCollection {
  const type = isRecord(value) ? value.type : undefined;
  if (!isRecord(value) || type !== 'FeatureCollection') {
    throw new Error(
      `Expected GeoJSON FeatureCollection, got type=${formatJsonValue(type)}`,
    );
  }
  if (!Array.isArray(value.features)) {
    throw new Error(
      'Expected GeoJSON FeatureCollection.features to be an array',
    );
  }
}

function formatJsonValue(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return value.toString();
    case 'object':
      return value === null
        ? 'null'
        : Array.isArray(value)
          ? 'array'
          : 'object';
    case 'function':
    case 'symbol':
      return typeof value;
  }
}

function summarizeFeatures(
  def: DatasetDefinition,
  features: GeoJsonFeature[],
): GeoJsonSummary {
  if (features.length === 0) {
    throw new Error(`Dataset "${def.key}" has no features`);
  }

  const geometry = geometrySchema(boundsFor(def));
  const types = new Set<string>();
  for (const [index, feature] of features.entries()) {
    if (!isRecord(feature) || feature.type !== 'Feature') {
      throw new Error(
        `Feature ${index} in "${def.key}" is not a GeoJSON Feature`,
      );
    }
    if (feature.properties !== null && !isRecord(feature.properties)) {
      throw new Error(
        `Feature ${index} in "${def.key}" has invalid properties`,
      );
    }
    const result = geometry.safeParse(feature.geometry);
    if (!result.success) {
      throw new Error(
        `Feature ${index} in "${def.key}" has invalid geometry: ${formatIssues(result.error)}`,
      );
    }
    types.add(result.data.type);
  }

  const bbox = geoJsonBbox({
    type: 'FeatureCollection',
    features,
  });
  if (!bbox) {
    throw new Error(`Dataset "${def.key}" has no valid coordinate bbox`);
  }

  return {
    featureCount: features.length,
    geometryTypes: [...types].sort((a, b) => a.localeCompare(b)),
    bbox,
  };
}

// GeoJSON geometry validation as a bounds-aware zod schema. The discriminated
// union admits only the six renderable types; GeometryCollection is excluded on
// purpose — Mapbox GL (and so the app's rnmapbox/maps ShapeSource) silently
// refuses to render it, so a dataset that smuggled one in would validate fine
// and then vanish on the map. The position refinement enforces finite, in-bounds
// coordinates, and polygon rings must be closed.
function geometrySchema(bounds: DatasetBounds) {
  const position = z
    .array(z.number())
    .min(2)
    .refine(
      (p) =>
        Number.isFinite(p[0]) &&
        Number.isFinite(p[1]) &&
        positionWithin([p[0], p[1]], bounds),
      'position is non-finite or outside configured dataset bounds',
    );
  const ring = z
    .array(position)
    .min(4)
    .refine(isRingClosed, 'polygon ring is not closed');
  const polygon = z.array(ring).min(1);

  return z.discriminatedUnion('type', [
    z.object({ type: z.literal('Point'), coordinates: position }),
    z.object({
      type: z.literal('MultiPoint'),
      coordinates: z.array(position).min(1),
    }),
    z.object({
      type: z.literal('LineString'),
      coordinates: z.array(position).min(2),
    }),
    z.object({
      type: z.literal('MultiLineString'),
      coordinates: z.array(z.array(position).min(2)).min(1),
    }),
    z.object({ type: z.literal('Polygon'), coordinates: polygon }),
    z.object({
      type: z.literal('MultiPolygon'),
      coordinates: z.array(polygon).min(1),
    }),
  ]);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function boundsFor(def: DatasetDefinition): DatasetBounds {
  return def.bounds ?? DEFAULT_DATASET_BOUNDS;
}

function positionWithin(
  position: [number, number],
  bounds: DatasetBounds,
): boolean {
  return (
    position[0] >= bounds[0] &&
    position[1] >= bounds[1] &&
    position[0] <= bounds[2] &&
    position[1] <= bounds[3]
  );
}

function featureId(
  datasetKey: string,
  normalized: Omit<NormalizedFeatureProperties, 'id'>,
  rawProps: Record<string, unknown>,
  index: number,
  seen: Set<string>,
): string {
  const rawId =
    normalized.sourceId ??
    rawString(rawProps.localId) ??
    rawString(rawProps.gml_id) ??
    rawString(rawProps.identifier) ??
    normalized.title ??
    `feature-${index + 1}`;

  const base = `${datasetKey}:${slugify(rawId) || `feature-${index + 1}`}`;
  let candidate = base;
  let duplicate = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${duplicate}`;
    duplicate += 1;
  }
  seen.add(candidate);
  return candidate;
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function geoJsonBbox(value: unknown): GeoJsonBbox | undefined {
  try {
    const [minX, minY, maxX, maxY] = turfBbox(
      value as Parameters<typeof turfBbox>[0],
      { recompute: true },
    );
    if (
      !isFiniteNumber(minX) ||
      !isFiniteNumber(minY) ||
      !isFiniteNumber(maxX) ||
      !isFiniteNumber(maxY)
    ) {
      return undefined;
    }
    return [minX, minY, maxX, maxY];
  } catch {
    return undefined;
  }
}

function foldBbox(
  acc: GeoJsonBbox | undefined,
  next: GeoJsonBbox,
): GeoJsonBbox {
  if (!acc) return next;
  return [
    Math.min(acc[0], next[0]),
    Math.min(acc[1], next[1]),
    Math.max(acc[2], next[2]),
    Math.max(acc[3], next[3]),
  ];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
