import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from '../src/app.controller';
import { ImpitHealthIndicator } from '../src/common/health/impit-health.indicator';
import { RedisHealthIndicator } from '../src/common/health/redis-health.indicator';
import { DatasetCatalogService } from '../src/map/dataset-catalog.service';

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  const httpServer = (): App => app.getHttpServer();

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: HealthCheckService, useValue: {} },
        { provide: MemoryHealthIndicator, useValue: {} },
        { provide: TypeOrmHealthIndicator, useValue: {} },
        { provide: ImpitHealthIndicator, useValue: {} },
        { provide: DiskHealthIndicator, useValue: {} },
        { provide: RedisHealthIndicator, useValue: {} },
        { provide: DatasetCatalogService, useValue: {} },
      ],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.setBaseViewsDir(join(process.cwd(), 'views'));
    app.setViewEngine('hbs');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /v1 returns the API index payload', async () => {
    const res = await request(httpServer()).get('/v1').expect(200);

    expect(res.body).toEqual({
      name: 'BlueBahar API',
      version: 'v1',
      health: {
        live: '/v1/health/live',
        ready: '/v1/health/ready',
        diagnostics: '/v1/health/diagnostics',
      },
    });
  });

  it('GET /v1/health/live returns a live status', async () => {
    const res = await request(httpServer()).get('/v1/health/live').expect(200);

    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET / renders the public landing page', async () => {
    const res = await request(httpServer()).get('/').expect(200);

    expect(res.text).toContain(
      '<title>BlueBaħar - Know before you go out at sea</title>',
    );
  });

  it('GET /tos renders the public terms page', async () => {
    const res = await request(httpServer()).get('/tos').expect(200);

    expect(res.text).toContain('<title>Terms of Service - BlueBaħar</title>');
  });

  it('GET /privacy renders the public privacy page', async () => {
    const res = await request(httpServer()).get('/privacy').expect(200);

    expect(res.text).toContain('<title>Privacy Policy - BlueBaħar</title>');
  });
});
