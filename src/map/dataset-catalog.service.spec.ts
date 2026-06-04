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
    expect(first.kind).toMatch(/^(interactive|context)$/);
    expect(first.sourceUrl).toMatch(/^https?:\/\//);
    expect(typeof first.featureCount).toBe('number');
    expect(Array.isArray(first.geometryTypes)).toBe(true);
    expect(first.geometryTypes.length).toBeGreaterThan(0);
    expect(first.bbox).toHaveLength(4);
    expect(typeof first.byteSize).toBe('number');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('surfaces publisher attribution for datasets that declare it', () => {
    const beaches = service.list().find((dataset) => dataset.key === 'beaches');

    expect(beaches?.attribution).toEqual({
      name: 'Environmental Health Directorate, Ministry for Health (Malta)',
      url: 'https://environmentalhealth.gov.mt/en/ehs/wrau/bathing-water-profiles/',
    });
  });

  it('returns a payload string for a known dataset key', () => {
    const entry = service.requireEntry(DATASETS[0].key);

    expect(entry.metadata.key).toBe(DATASETS[0].key);
    expect(typeof entry.payload).toBe('string');
    const parsed = JSON.parse(entry.payload) as { type?: unknown };
    expect(parsed.type).toBe('FeatureCollection');
  });

  it('serves normalized properties for interactive datasets', () => {
    const interactiveKey = DATASETS.find((d) => d.kind === 'interactive')?.key;
    if (!interactiveKey)
      throw new Error('Expected at least one interactive dataset');
    const entry = service.requireEntry(interactiveKey);
    const fc = JSON.parse(entry.payload) as {
      bbox?: number[];
      features: {
        id?: string;
        bbox?: number[];
        properties: Record<string, unknown>;
      }[];
    };
    expect(fc.bbox).toHaveLength(4);
    expect(fc.features.length).toBeGreaterThan(0);
    const first = fc.features[0];
    expect(typeof first.id).toBe('string');
    expect(first.bbox).toHaveLength(4);
    expect(first.properties.id).toBe(first.id);
    expect(typeof first.properties.title).toBe('string');
    expect(typeof first.properties.sourceId).toBe('string');
    // Raw INSPIRE noise must not leak through the normalization layer.
    expect(first.properties.gml_id).toBeUndefined();
    expect(first.properties.namespace).toBeUndefined();
  });

  it('serves context datasets as raw GeoJSON', () => {
    const contextKey = DATASETS.find((d) => d.kind === 'context')?.key;
    if (!contextKey) throw new Error('Expected at least one context dataset');
    const entry = service.requireEntry(contextKey);
    const fc = JSON.parse(entry.payload) as { type: string };
    expect(fc.type).toBe('FeatureCollection');
  });

  it('reports catalog health and loaded dataset status', () => {
    const status = service.status();

    expect(status.loaded).toBe(DATASETS.length);
    expect(status.configured).toBe(DATASETS.length);
    expect(status.unavailable).toEqual([]);
    expect(status.datasets).toHaveLength(DATASETS.length);
    expect(service.healthCheck().dataset_catalog).toEqual({
      status: 'up',
      loaded: DATASETS.length,
      configured: DATASETS.length,
      unavailableCount: 0,
    });
  });

  it('throws not found for unknown dataset keys', () => {
    expect(() => service.requireEntry('missing-dataset')).toThrow(
      NotFoundException,
    );
  });
});
