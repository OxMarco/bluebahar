import { NotFoundException } from '@nestjs/common';
import { DATASETS } from './datasets';
import { DatasetCatalogService } from './dataset-catalog.service';

describe('DatasetCatalogService', () => {
  let service: DatasetCatalogService;

  beforeEach(async () => {
    service = new DatasetCatalogService();
    await service.onApplicationBootstrap();
  });

  it('loads committed GeoJSON datasets into sorted metadata', () => {
    const datasets = service.list();

    expect(datasets).toHaveLength(DATASETS.length);
    expect(datasets.map((dataset) => dataset.name)).toEqual(
      [...datasets.map((dataset) => dataset.name)].sort((a, b) =>
        a.localeCompare(b),
      ),
    );

    const first = datasets[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('Expected at least one dataset');
    expect(typeof first.key).toBe('string');
    expect(typeof first.name).toBe('string');
    expect(first.sourceUrl).toMatch(/^https?:\/\//);
    expect(typeof first.featureCount).toBe('number');
    expect(typeof first.byteSize).toBe('number');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns the loaded file path for a known dataset key', () => {
    const entry = service.requireEntry(DATASETS[0].key);

    expect(entry.metadata.key).toBe(DATASETS[0].key);
    expect(entry.filePath).toContain(`${DATASETS[0].key}.geojson`);
  });

  it('throws not found for unknown dataset keys', () => {
    expect(() => service.requireEntry('missing-dataset')).toThrow(
      NotFoundException,
    );
  });
});
