import { Controller, Get, Render } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  type HealthIndicatorResult,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { SOURCES as NOTICE_SOURCES } from './scraper/parser/notice-to-mariners';
import { ScraperService } from './scraper/scraper.service';
import { ImpitHealthIndicator } from './common/health/impit-health.indicator';

const SCRAPER_PING_URLS = (() => {
  const seenOrigin = new Set<string>();
  const urls: string[] = [];
  for (const url of NOTICE_SOURCES) {
    const origin = new URL(url).origin;
    if (seenOrigin.has(origin)) continue;
    seenOrigin.add(origin);
    urls.push(url);
  }
  return urls;
})();

@Controller('/')
export class AppController {
  constructor(
    private health: HealthCheckService,
    private memory: MemoryHealthIndicator,
    private db: TypeOrmHealthIndicator,
    private http: ImpitHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly scraper: ScraperService,
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
      name: 'BlueBahar API',
      version: 'v1',
      health: {
        live: '/v1/health/live',
        ready: '/v1/health/ready',
        diagnostics: '/v1/health/diagnostics',
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
      () => this.pingRedis(),
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
      () => this.pingRedis(),
      ...SCRAPER_PING_URLS.map(
        (url) => () => this.http.pingCheck(new URL(url).hostname, url),
      ),
      () =>
        this.disk.checkStorage('storage', {
          path: '/',
          thresholdPercent: 0.85,
        }),
    ]);
  }

  private async pingRedis(): Promise<HealthIndicatorResult> {
    try {
      const ok = await this.scraper.pingRedis();
      return { redis: { status: ok ? 'up' : 'down' } };
    } catch (err) {
      return {
        redis: {
          status: 'down',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
