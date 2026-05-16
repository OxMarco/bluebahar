import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATASETS } from './datasets';

interface GeoJsonFeatureCollection {
  type?: string;
  features?: unknown[];
}

const DATASETS_DIR = resolve(process.cwd(), 'data/datasets');

describe('map datasets catalogue', () => {
  it('has unique dataset keys', () => {
    const keys = DATASETS.map((dataset) => dataset.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(DATASETS)(
    'points $key at a valid GeoJSON FeatureCollection',
    (dataset) => {
      const filePath = resolve(DATASETS_DIR, `${dataset.key}.geojson`);
      const parsed = JSON.parse(
        readFileSync(filePath, 'utf8'),
      ) as GeoJsonFeatureCollection;

      expect(parsed.type).toBe('FeatureCollection');
      expect(Array.isArray(parsed.features)).toBe(true);
      expect(parsed.features?.length).toBeGreaterThan(0);
    },
  );
});
