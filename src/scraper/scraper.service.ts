import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { listNoticeLinks } from './parser/notice-to-mariners';
import { DATASETS } from './datasets';

@Injectable()
export class ScraperService implements OnApplicationBootstrap, OnModuleDestroy {
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
        // Each scrape method already forwards to Sentry; just log here so
        // bootstrap output stays informative without double-capturing.
        this.logger.error(`Bootstrap scrape ${names[i]} failed`, r.reason);
      }
    });
  }

  // @nestjs/schedule logs unhandled cron errors but does not propagate them to
  // Sentry's global filter. Wrap each cron operation so failures reach Sentry
  // regardless of caller (cron tick or bootstrap).
  private async runScrape<T>(name: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      Sentry.captureException(err, { tags: { scraper: name } });
      throw err;
    }
  }

  async onModuleDestroy() {
    this.logger.log('Shutdown: pausing queue; worker drains active jobs...');
    // BullMQ queue.pause() stops new job pickup globally. The worker's active
    // jobs continue; @nestjs/bullmq closes the worker on Nest shutdown which
    // waits for them to finish.
    await this.queue.pause();
    this.logger.log('Scraper queue paused');
  }

  @Cron(CronExpression.EVERY_12_HOURS)
  async scrapeNoticeToMariners() {
    return this.runScrape('notice-to-mariners', async () => {
      const links = await listNoticeLinks();

      const stored = await this.repo.find({ select: { source: true } });
      const storedUrls = new Set(stored.map((n) => n.source));

      const inFlight = await this.queue.getJobs([
        'waiting',
        'active',
        'delayed',
      ]);
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
    });
  }

  @Cron(CronExpression.EVERY_3_HOURS)
  async scrapeWeather() {
    return this.runScrape('weather', async () => {
      const inFlight = await this.queue.getJobs([
        'waiting',
        'active',
        'delayed',
      ]);
      const alreadyQueued = inFlight.some((j) => j.name === 'weather');
      if (alreadyQueued) {
        this.logger.log('Weather job already in flight, skipping enqueue');
        return { message: 'Weather job already in flight', enqueued: 0 };
      }

      await this.queue.add('weather', {});
      this.logger.log('Enqueued weather forecast fetch');
      return { message: 'Enqueued', name: 'weather' };
    });
  }

  // Datasets change on a multi-year cadence — weekly is plenty, the processor
  // short-circuits on unchanged sha256 so most runs are no-ops.
  @Cron(CronExpression.EVERY_WEEK)
  async scrapeDatasets() {
    return this.runScrape('datasets', async () => {
      const inFlight = await this.queue.getJobs([
        'waiting',
        'active',
        'delayed',
      ]);
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
    });
  }
}
