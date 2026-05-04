import { Controller, Get } from '@nestjs/common';
import {
  DiskHealthIndicator,
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { DATASETS } from './scraper/datasets';
import { WEATHER_URL } from './scraper/parser/weather';
import { SOURCES as NOTICE_SOURCES } from './scraper/parser/notice-to-mariners';
import { ImpitHealthIndicator } from './common/health/impit-health.indicator';

const SCRAPER_PING_URLS = (() => {
  const seenOrigin = new Set<string>();
  const urls: string[] = [];
  for (const url of [
    ...DATASETS.map((d) => d.url),
    WEATHER_URL,
    ...NOTICE_SOURCES,
  ]) {
    const origin = new URL(url).origin;
    if (seenOrigin.has(origin)) continue;
    seenOrigin.add(origin);
    urls.push(url);
  }
  return urls;
})();

@Controller({
  path: '/',
  version: '1',
})
export class AppController {
  constructor(
    private health: HealthCheckService,
    private memory: MemoryHealthIndicator,
    private db: TypeOrmHealthIndicator,
    private http: ImpitHealthIndicator,
    private readonly disk: DiskHealthIndicator,
  ) {}

  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.memory.checkHeap('memory_heap', 150 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 150 * 1024 * 1024),
      () => this.db.pingCheck('database'),
      ...SCRAPER_PING_URLS.map(
        (url) => () => this.http.pingCheck(new URL(url).hostname, url),
      ),
      () =>
        this.disk.checkStorage('storage', { path: '/', thresholdPercent: 0.5 }),
    ]);
  }
}
