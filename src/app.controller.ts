import { Controller, Get, Render } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { HttpHealthIndicator } from './common/health/http-health.indicator';
import { RedisHealthIndicator } from './common/health/redis-health.indicator';
import { DatasetCatalogService } from './map/dataset-catalog.service';
import { DEFAULT_COMMUNITY_MAP_MID } from './map/community-map/community-map-import.service';
import { communityMapKmlUrl } from './map/community-map/kml-source';

const MAP_SOURCE_URL = communityMapKmlUrl(DEFAULT_COMMUNITY_MAP_MID);

@Controller('/')
export class AppController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly memory: MemoryHealthIndicator,
    private readonly db: TypeOrmHealthIndicator,
    private readonly http: HttpHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly datasets: DatasetCatalogService,
  ) {}

  @Get()
  @Render('index')
  root() {
    return { version: 'v1' };
  }

  @Get('/tos')
  @Render('tos')
  tos() {
    return { version: 'v1' };
  }

  @Get('/privacy')
  @Render('privacy')
  privacy() {
    return { version: 'v1' };
  }

  @Get('/v1')
  rootApi() {
    return {
      name: 'BlueBaħar API',
      version: 'v1',
      health: {
        live: '/v1/health/live',
        ready: '/v1/health/ready',
        diagnostics: '/v1/health/diagnostics',
      },
      map: {
        notices: '/v1/map/notices',
        noticeMetrics: '/v1/map/notices/metrics',
        reportNotice: '/v1/map/notices/report/:id',
        reportPoint: '/v1/map/reports',
        datasets: '/v1/map/datasets',
        dataset: '/v1/map/datasets/:key',
      },
    };
  }

  @Get('/v1/health/live')
  live() {
    return { status: 'ok' };
  }

  @Get('/v1/health/ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redis.pingCheck('redis'),
      () => this.datasets.healthCheck(),
      () =>
        this.disk.checkStorage('storage', {
          path: '/',
          thresholdPercent: 0.95,
        }),
    ]);
  }

  @Get('/v1/health/diagnostics')
  @HealthCheck()
  diagnostics() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 384 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 450 * 1024 * 1024),
      () => this.db.pingCheck('database'),
      () => this.redis.pingCheck('redis'),
      () => this.datasets.healthCheck(),
      () => this.http.pingCheck('google-my-maps', MAP_SOURCE_URL),
      () =>
        this.disk.checkStorage('storage', {
          path: '/',
          thresholdPercent: 0.85,
        }),
    ]);
  }
}
