import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Repository } from 'typeorm';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { listNoticeLinks } from './parser/notice-to-mariners';
import { DATASETS } from './datasets';

@Injectable()
export class ScraperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ScraperService.name);
  private readonly noticeBatchSize: number;

  constructor(
    @InjectRepository(NoticeToMariners)
    private readonly repo: Repository<NoticeToMariners>,
    @InjectQueue('scraper')
    private readonly queue: Queue,
    config: ConfigService,
  ) {
    this.noticeBatchSize = config.getOrThrow<number>(
      'NOTICE_SCRAPE_BATCH_SIZE',
    );
  }

  async onApplicationBootstrap() {
    this.logger.log('Bootstrap: kicking off initial scraper run');
    const results = await Promise.allSettled([
      this.scrapeNoticeToMariners(),
      this.scrapeWeather(),
      this.scrapeDatasets(),
    ]);
    const names = ['notice-to-mariners', 'weather', 'datasets'] as const;
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.error(`Bootstrap scrape ${names[i]} failed`, r.reason);
      }
    });
  }

  async onModuleDestroy() {
    this.logger.log('Shutdown: pausing queue and draining active jobs...');
    // pause(isLocal=true, doNotWaitActive=false) — stop picking up new jobs,
    // wait for any in-flight job to finish before resolving.
    await this.queue.pause(true, false);
    this.logger.log('Scraper queue drained');
  }

  @Cron(CronExpression.EVERY_12_HOURS)
  async scrapeNoticeToMariners() {
    const links = await listNoticeLinks();

    const stored = await this.repo.find({ select: { source: true } });
    const storedUrls = new Set(stored.map((n) => n.source));

    const inFlight = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    const inFlightUrls = new Set(
      inFlight
        .filter((j) => j.name === 'notice-to-mariners')
        .map((j) => (j.data as { url: string }).url),
    );

    const next = links
      .filter((l) => !storedUrls.has(l.url) && !inFlightUrls.has(l.url))
      .slice(0, this.noticeBatchSize);
    if (next.length === 0) {
      this.logger.log(
        `No new notices to enqueue (${links.length} active, ${storedUrls.size} stored, ${inFlightUrls.size} in flight)`,
      );
      return { message: 'No new notices', enqueued: 0 };
    }

    for (const link of next) {
      await this.queue.add('notice-to-mariners', { url: link.url });
    }
    this.logger.log(`Enqueued ${next.length} notice(s)`);
    return { message: 'Enqueued', enqueued: next.length };
  }

  @Cron(CronExpression.EVERY_3_HOURS)
  async scrapeWeather() {
    const inFlight = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    const alreadyQueued = inFlight.some((j) => j.name === 'weather');
    if (alreadyQueued) {
      this.logger.log('Weather job already in flight, skipping enqueue');
      return { message: 'Weather job already in flight', enqueued: 0 };
    }

    await this.queue.add('weather', {});
    this.logger.log('Enqueued weather forecast fetch');
    return { message: 'Enqueued', name: 'weather' };
  }

  // Datasets change on a multi-year cadence — weekly is plenty, the processor
  // short-circuits on unchanged sha256 so most runs are no-ops.
  @Cron(CronExpression.EVERY_WEEK)
  async scrapeDatasets() {
    const inFlight = await this.queue.getJobs(['waiting', 'active', 'delayed']);
    const queuedKeys = new Set(
      inFlight
        .filter((j) => j.name === 'dataset')
        .map((j) => (j.data as { key: string }).key),
    );

    let enqueued = 0;
    for (const dataset of DATASETS) {
      if (queuedKeys.has(dataset.key)) continue;
      await this.queue.add('dataset', { key: dataset.key });
      enqueued++;
    }

    this.logger.log(`Enqueued ${enqueued} dataset job(s)`);
    return { message: 'Enqueued', enqueued };
  }
}
