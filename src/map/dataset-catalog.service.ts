import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { HealthIndicatorResult } from '@nestjs/terminus';
import * as Sentry from '@sentry/nestjs';
import { bbox as turfBbox } from '@turf/bbox';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DATASETS,
  DEFAULT_DATASET_BOUNDS,
  type DatasetAttribution,
  type DatasetBounds,
  type DatasetDefinition,
  type DatasetKind,
} from './datasets';
import { ADAPTERS } from './normalize/adapters';
import type { NormalizedFeatureProperties } from './normalize/normalized-feature';

// GeoJSON files are committed to the repo and shipped with the deploy artifact;
// resolved from process.cwd() since both `npm start` and the Dockerfile's
// WORKDIR /app put us at the project root.
const DATASETS_DIR = resolve(process.cwd(), 'data/datasets');
const SUPPORTED_GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

export type GeoJsonBbox = [number, number, number, number];

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
export class DatasetCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatasetCatalogService.name);
  private readonly entries = new Map<string, DatasetEntry>();
  private readonly loadFailures = new Map<string, string>();

  async onApplicationBootstrap() {
    this.entries.clear();
    this.loadFailures.clear();

    for (const def of DATASETS) {
      const filePath = resolve(DATASETS_DIR, `${def.key}.geojson`);
      try {
        const entry = await this.loadEntry(def, filePath);
        this.entries.set(def.key, entry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
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
    return {
      dataset_catalog: {
        status:
          status.loaded === status.configured && status.unavailable.length === 0
            ? 'up'
            : 'down',
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
    this.entries.set(def.key, entry);
    this.loadFailures.delete(def.key);
    return entry.metadata;
  }

  private async loadEntry(
    def: DatasetDefinition,
    filePath: string,
  ): Promise<DatasetEntry> {
    const raw = await readFile(filePath, 'utf8');
    return this.buildEntry(def, raw);
  }

  private buildEntry(def: DatasetDefinition, raw: string): DatasetEntry {
    const parsed = JSON.parse(raw) as GeoJsonFeatureCollection;

    // Interactive datasets rebuild their payload from normalized features, so
    // normalize() owns validation and can drop unrenderable features (null
    // geometry, missing title). Context datasets are served verbatim, so every
    // feature must pass up front. Validating all geometry here would reject a
    // whole interactive layer for a single null-geometry feature.
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
    parsed: GeoJsonFeatureCollection,
  ): { payload: string; summary: GeoJsonSummary } {
    const adapter = ADAPTERS[def.key];
    if (!adapter) {
      // An interactive dataset without an adapter is a configuration bug, not a
      // runtime fallback path — fail loudly at boot so it doesn't ship.
      throw new Error(
        `Interactive dataset "${def.key}" has no adapter registered`,
      );
    }
    if (!isRecord(parsed) || parsed.type !== 'FeatureCollection') {
      throw new Error(
        `Expected GeoJSON FeatureCollection, got type=${String(parsed?.type ?? 'undefined')}`,
      );
    }
    if (!Array.isArray(parsed.features)) {
      throw new Error(
        'Expected GeoJSON FeatureCollection.features to be an array',
      );
    }

    const out: GeoJsonFeature[] = [];
    let droppedNoTitle = 0;
    let droppedNoGeometry = 0;
    const seenIds = new Set<string>();
    for (const [index, feature] of parsed.features.entries()) {
      // Upstream feature services return rows without a mapped location as
      // null-geometry features; they can't be plotted, so skip them rather
      // than fail the layer.
      if (!isRecord(feature.geometry)) {
        droppedNoGeometry += 1;
        continue;
      }
      const rawProps = (feature.properties ?? {}) as Record<string, unknown>;
      const normalized = adapter(rawProps);
      if (normalized === null) {
        droppedNoTitle += 1;
        continue;
      }
      const id = featureId(def.key, normalized, rawProps, index, seenIds);
      const bbox = geoJsonBbox(feature.geometry);
      out.push({
        type: 'Feature',
        id,
        ...(bbox ? { bbox } : {}),
        geometry: feature.geometry,
        properties: { ...normalized, id },
      });
    }
    const dropped = droppedNoTitle + droppedNoGeometry;
    if (dropped > 0) {
      this.logger.warn(
        `Dropped ${dropped}/${parsed.features.length} feature(s) from "${def.key}" (${droppedNoTitle} missing title, ${droppedNoGeometry} null geometry)`,
      );
    }
    if (out.length === 0) {
      throw new Error(
        `Dataset "${def.key}" produced no features after normalization (${dropped}/${parsed.features.length} dropped)`,
      );
    }
    const summary = summarizeFeatures(def, out);
    const payload = JSON.stringify({
      type: 'FeatureCollection',
      bbox: summary.bbox,
      features: out,
    });
    return { payload, summary };
  }
}

function validateFeatureCollection(
  def: DatasetDefinition,
  value: GeoJsonFeatureCollection,
): GeoJsonSummary {
  if (!isRecord(value) || value.type !== 'FeatureCollection') {
    throw new Error(
      `Expected GeoJSON FeatureCollection, got type=${String(value?.type ?? 'undefined')}`,
    );
  }
  if (!Array.isArray(value.features)) {
    throw new Error(
      'Expected GeoJSON FeatureCollection.features to be an array',
    );
  }
  return summarizeFeatures(def, value.features);
}

function summarizeFeatures(
  def: DatasetDefinition,
  features: GeoJsonFeature[],
): GeoJsonSummary {
  const bounds = boundsFor(def);
  if (features.length === 0) {
    throw new Error(`Dataset "${def.key}" has no features`);
  }

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
    validateGeometry(def.key, bounds, index, feature.geometry, types);
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

function validateGeometry(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  geometry: unknown,
  types: Set<string>,
) {
  if (!isRecord(geometry)) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has no geometry`,
    );
  }

  const type = geometry.type;
  if (typeof type !== 'string' || !SUPPORTED_GEOMETRY_TYPES.has(type)) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has unsupported geometry type ${String(type)}`,
    );
  }
  types.add(type);

  if (type === 'GeometryCollection') {
    if (
      !Array.isArray(geometry.geometries) ||
      geometry.geometries.length === 0
    ) {
      throw new Error(
        `Feature ${featureIndex} in "${datasetKey}" has an empty GeometryCollection`,
      );
    }
    for (const child of geometry.geometries) {
      validateGeometry(datasetKey, bounds, featureIndex, child, types);
    }
    return;
  }

  validateCoordinates(
    datasetKey,
    bounds,
    featureIndex,
    type,
    geometry.coordinates,
  );
  const bbox = geoJsonBbox(geometry);
  if (!bbox) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has no valid coordinates`,
    );
  }
}

function validateCoordinates(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  type: string,
  coordinates: unknown,
) {
  switch (type) {
    case 'Point':
      validatePosition(datasetKey, bounds, featureIndex, coordinates);
      return;
    case 'MultiPoint':
      validatePositionArray(datasetKey, bounds, featureIndex, coordinates, 1);
      return;
    case 'LineString':
      validatePositionArray(datasetKey, bounds, featureIndex, coordinates, 2);
      return;
    case 'MultiLineString':
      validateLineArray(datasetKey, bounds, featureIndex, coordinates, 1);
      return;
    case 'Polygon':
      validatePolygon(datasetKey, bounds, featureIndex, coordinates);
      return;
    case 'MultiPolygon':
      if (!Array.isArray(coordinates) || coordinates.length === 0) {
        throw new Error(
          `Feature ${featureIndex} in "${datasetKey}" has an empty MultiPolygon`,
        );
      }
      for (const polygon of coordinates) {
        validatePolygon(datasetKey, bounds, featureIndex, polygon);
      }
      return;
    default:
      throw new Error(
        `Feature ${featureIndex} in "${datasetKey}" has unsupported geometry type ${type}`,
      );
  }
}

function validatePositionArray(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  coordinates: unknown,
  minLength: number,
) {
  if (!Array.isArray(coordinates) || coordinates.length < minLength) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has too few coordinates`,
    );
  }
  for (const position of coordinates) {
    validatePosition(datasetKey, bounds, featureIndex, position);
  }
}

function validateLineArray(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  coordinates: unknown,
  minLength: number,
) {
  if (!Array.isArray(coordinates) || coordinates.length < minLength) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has too few line parts`,
    );
  }
  for (const line of coordinates) {
    validatePositionArray(datasetKey, bounds, featureIndex, line, 2);
  }
}

function validatePolygon(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  coordinates: unknown,
) {
  if (!isUnknownArray(coordinates) || coordinates.length === 0) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has an empty polygon`,
    );
  }
  for (const ring of coordinates) {
    validatePositionArray(datasetKey, bounds, featureIndex, ring, 4);
    if (!isUnknownArray(ring)) {
      throw new Error(
        `Feature ${featureIndex} in "${datasetKey}" has an invalid polygon ring`,
      );
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (
      !isUnknownArray(first) ||
      !isUnknownArray(last) ||
      first[0] !== last[0] ||
      first[1] !== last[1]
    ) {
      throw new Error(
        `Feature ${featureIndex} in "${datasetKey}" has an open polygon ring`,
      );
    }
  }
}

function validatePosition(
  datasetKey: string,
  bounds: DatasetBounds,
  featureIndex: number,
  position: unknown,
) {
  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    !isFiniteNumber(position[0]) ||
    !isFiniteNumber(position[1])
  ) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has invalid coordinates`,
    );
  }
  if (!positionWithin([position[0], position[1]], bounds)) {
    throw new Error(
      `Feature ${featureIndex} in "${datasetKey}" has coordinates outside configured dataset bounds`,
    );
  }
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
