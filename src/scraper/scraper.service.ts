import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { listNoticeLinks } from './parser/notice-to-mariners';

@Injectable()
export class ScraperService implements OnApplicationBootstrap {
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
    try {
      await this.scrapeNoticeToMariners();
    } catch (err) {
      // scrapeNoticeToMariners already forwards to Sentry; just log here so
      // bootstrap output stays informative without double-capturing.
      this.logger.error('Bootstrap scrape notice-to-mariners failed', err);
    }
  }

  // @nestjs/schedule logs unhandled cron errors but does not propagate them to
  // Sentry's global filter, so capture in-line before rethrowing.
  @Cron(CronExpression.EVERY_12_HOURS)
  async scrapeNoticeToMariners() {
    try {
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
    } catch (err) {
      Sentry.captureException(err, {
        tags: { scraper: 'notice-to-mariners' },
      });
      throw err;
    }
  }
}
