import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bbox as turfBbox } from '@turf/bbox';
import { errorMessage } from '../src/common/utils/error-message';
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
        error: errorMessage(err),
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

  for (const [index, feature] of value.features.entries()) {
    if (!isRecord(feature) || feature.type !== 'Feature') {
      throw new Error(`Feature ${index} is not a GeoJSON Feature`);
    }
    const featureBbox = geoJsonBbox(feature, bounds);
    if (!featureBbox) {
      throw new Error(`Feature ${index} has no valid geometry`);
    }
  }
  const bbox = geoJsonBbox(value, bounds);
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

function geoJsonBbox(
  value: unknown,
  bounds: DatasetBounds,
): DatasetBounds | undefined {
  try {
    const [minX, minY, maxX, maxY] = turfBbox(
      value as Parameters<typeof turfBbox>[0],
      { recompute: true },
    );
    const bbox: DatasetBounds = [minX, minY, maxX, maxY];
    if (
      bbox.some((coord) => !Number.isFinite(coord)) ||
      bbox[0] < bounds[0] ||
      bbox[1] < bounds[1] ||
      bbox[2] > bounds[2] ||
      bbox[3] > bounds[3]
    ) {
      return undefined;
    }
    return bbox;
  } catch {
    return undefined;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
