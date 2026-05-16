import { INestApplication, VersioningType } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { MapController } from '../src/map/map.controller';
import { DATASETS } from '../src/map/datasets';
import { MapService } from '../src/map/map.service';

describe('Map datasets API (e2e)', () => {
  let app: INestApplication<App>;

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
    sourceUrl: dataset.sourceUrl,
    featureCount: 1,
    byteSize: fileStats.size,
    sha256: createHash('sha256').update(dataset.key).digest('hex'),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CacheModule.register()],
      controllers: [MapController],
      providers: [
        {
          provide: MapService,
          useValue: {
            listDatasets: jest.fn(() => [source]),
            requireDataset: jest.fn(() => ({
              metadata: source,
              filePath,
            })),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('GET /v1/map/datasets/:key streams GeoJSON', async () => {
    const res = await request(app.getHttpServer())
      .get(`/v1/map/datasets/${dataset.key}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('application/geo+json');
    expect(res.headers['cache-control']).toBe('public, max-age=3600');
    expect(JSON.parse(res.text)).toHaveProperty('type', 'FeatureCollection');
  });
});
