import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  DATASETS,
  DEFAULT_DATASET_BOUNDS,
  type DatasetBounds,
} from '../src/map/datasets';

interface Summary {
  featureCount: number;
  bbox: DatasetBounds;
  sha256: string;
}

type RefreshResult =
  | {
      key: string;
      status: 'unchanged' | 'changed';
      written: boolean;
      current: Summary | null;
      next: Summary;
    }
  | {
      key: string;
      status: 'failed';
      error: string;
    };

const DATASETS_DIR = resolve(process.cwd(), 'data/datasets');
const WRITE = process.argv.includes('--write');
const ONLY = argValue('--dataset');

async function main() {
  const selected = ONLY
    ? DATASETS.filter((dataset) => dataset.key === ONLY)
    : DATASETS;
  if (selected.length === 0) {
    throw new Error(`Unknown dataset key: ${ONLY}`);
  }

  await mkdir(DATASETS_DIR, { recursive: true });
  const results: RefreshResult[] = [];
  for (const dataset of selected) {
    try {
      const response = await fetch(dataset.sourceUrl, {
        headers: {
          accept: 'application/geo+json, application/json;q=0.9, */*;q=0.1',
          'user-agent': 'BlueBahar dataset refresher',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const text = await response.text();
      const parsed = JSON.parse(text) as unknown;
      const bounds = dataset.bounds ?? DEFAULT_DATASET_BOUNDS;
      const next = serialize(parsed, bounds);
      const nextSummary = summarize(JSON.parse(next), bounds);
      const current = await readCurrent(dataset.key);
      const currentSummary = current
        ? summarize(JSON.parse(current), bounds)
        : null;

      if (WRITE) {
        await writeFile(resolve(DATASETS_DIR, `${dataset.key}.geojson`), next);
      }

      results.push({
        key: dataset.key,
        status:
          currentSummary?.sha256 === nextSummary.sha256
            ? 'unchanged'
            : 'changed',
        written: WRITE,
        current: currentSummary,
        next: nextSummary,
      });
    } catch (err) {
      results.push({
        key: dataset.key,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const result of results) {
    if (result.status === 'failed') {
      console.error(`${result.key}: failed - ${result.error}`);
      continue;
    }
    console.log(
      `${result.key}: ${result.status}${result.written ? ' (written)' : ''}`,
    );
    console.log(`  current: ${formatSummary(result.current)}`);
    console.log(`  next:    ${formatSummary(result.next)}`);
  }

  if (results.some((result) => result.status === 'failed')) {
    process.exitCode = 1;
  }
}

function serialize(value: unknown, bounds: DatasetBounds): string {
  const summary = summarize(value, bounds);
  return `${JSON.stringify({ ...(value as object), bbox: summary.bbox }, null, 2)}\n`;
}

function summarize(value: unknown, bounds: DatasetBounds): Summary {
  if (!isRecord(value) || value.type !== 'FeatureCollection') {
    throw new Error('Expected GeoJSON FeatureCollection');
  }
  if (!Array.isArray(value.features) || value.features.length === 0) {
    throw new Error('Expected at least one GeoJSON feature');
  }

  let bbox: DatasetBounds | undefined;
  for (const [index, feature] of value.features.entries()) {
    if (!isRecord(feature) || feature.type !== 'Feature') {
      throw new Error(`Feature ${index} is not a GeoJSON Feature`);
    }
    const featureBbox = geometryBbox(feature.geometry, bounds);
    if (!featureBbox) {
      throw new Error(`Feature ${index} has no valid geometry`);
    }
    bbox = mergeBbox(bbox, featureBbox);
  }
  if (!bbox) {
    throw new Error('Dataset has no valid coordinate bbox');
  }

  const normalized = JSON.stringify({ ...value, bbox });
  return {
    featureCount: value.features.length,
    bbox,
    sha256: createHash('sha256').update(normalized).digest('hex'),
  };
}

function geometryBbox(
  geometry: unknown,
  bounds: DatasetBounds,
): DatasetBounds | undefined {
  if (!isRecord(geometry)) return undefined;
  if (
    geometry.type === 'GeometryCollection' &&
    Array.isArray(geometry.geometries)
  ) {
    let bbox: DatasetBounds | undefined;
    for (const child of geometry.geometries) {
      bbox = mergeBbox(bbox, geometryBbox(child, bounds));
    }
    return bbox;
  }

  const acc = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  visitCoordinates(geometry.coordinates, bounds, acc);
  if (!Number.isFinite(acc.minX)) return undefined;
  return [acc.minX, acc.minY, acc.maxX, acc.maxY];
}

function visitCoordinates(
  value: unknown,
  bounds: DatasetBounds,
  acc: { minX: number; minY: number; maxX: number; maxY: number },
) {
  if (!Array.isArray(value)) return;
  if (isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
    if (!positionWithin([value[0], value[1]], bounds)) {
      throw new Error('Coordinate outside configured dataset bounds');
    }
    acc.minX = Math.min(acc.minX, value[0]);
    acc.minY = Math.min(acc.minY, value[1]);
    acc.maxX = Math.max(acc.maxX, value[0]);
    acc.maxY = Math.max(acc.maxY, value[1]);
    return;
  }
  for (const child of value) {
    visitCoordinates(child, bounds, acc);
  }
}

function mergeBbox(
  current: DatasetBounds | undefined,
  next: DatasetBounds | undefined,
): DatasetBounds | undefined {
  if (!next) return current;
  if (!current) return next;
  return [
    Math.min(current[0], next[0]),
    Math.min(current[1], next[1]),
    Math.max(current[2], next[2]),
    Math.max(current[3], next[3]),
  ];
}

async function readCurrent(key: string): Promise<string | null> {
  try {
    return await readFile(resolve(DATASETS_DIR, `${key}.geojson`), 'utf8');
  } catch {
    return null;
  }
}

function formatSummary(summary: Summary | null): string {
  if (!summary) return 'missing';
  return `${summary.featureCount} feature(s), bbox ${summary.bbox.join(',')}, sha256 ${summary.sha256}`;
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
