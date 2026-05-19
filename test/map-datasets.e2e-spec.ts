import { VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { MapController } from '../src/map/map.controller';
import { DATASETS } from '../src/map/datasets';
import { MapService } from '../src/map/map.service';

describe('Map datasets API (e2e)', () => {
  let app: NestExpressApplication;

  const dataset = DATASETS[0];
  const filePath = resolve(
    process.cwd(),
    'data/datasets',
    `${dataset.key}.geojson`,
  );
  const fileStats = statSync(filePath);
  const source = {
    key: dataset.key,
    name: dataset.name,
    kind: dataset.kind,
    sourceUrl: dataset.sourceUrl,
    featureCount: 1,
    geometryTypes: ['Point'],
    bbox: [14.5, 35.9, 14.5, 35.9],
    byteSize: fileStats.size,
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [MapController],
      providers: [
        {
          provide: MapService,
          useValue: {
            listDatasets: jest.fn(() => [source]),
            getNoticeMetrics: jest.fn(() => ({
              asOf: '2026-01-01T00:00:00.000Z',
              total: 0,
              publicCount: 0,
              needsReviewCount: 0,
              activePublicCount: 0,
              activeNeedsReviewCount: 0,
              byKind: [],
            })),
            requireDataset: jest.fn(() => ({
              metadata: source,
              payload:
                '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[14.5,35.9]},"properties":{}}]}',
            })),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setBaseViewsDir(resolve(process.cwd(), 'views'));
    app.setViewEngine('hbs');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /v1/map/datasets returns dataset metadata', async () => {
    const res = await request(app.getHttpServer())
      .get('/v1/map/datasets')
      .expect(200);

    expect(res.body).toEqual([source]);
  });

  it('GET /v1/map renders the map page', async () => {
    const res = await request(app.getHttpServer()).get('/v1/map').expect(200);

    expect(res.text).toContain('<title>Map - BlueBaħar</title>');
    expect(res.text).toContain("const DATASETS_URL = '/v1/map/datasets';");
  });

  it('GET /v1/map/datasets/:key streams GeoJSON', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/map/datasets/${dataset.key}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/geo+json');
    expect(res.headers['x-dataset-key']).toBe(dataset.key);
    expect(res.headers['x-dataset-kind']).toBe(dataset.kind);
    expect(res.headers['x-dataset-feature-count']).toBe('1');
    expect(res.headers['x-dataset-geometry-types']).toBe('Point');
    expect(res.headers['x-dataset-bbox']).toBe('14.5,35.9,14.5,35.9');
    expect(JSON.parse(res.text)).toHaveProperty('type', 'FeatureCollection');
  });
});
