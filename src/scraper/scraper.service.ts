import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { Logs } from './entities/logs.entity';
import { listNoticeLinks } from './parser/notice-to-mariners';
import { LogType } from './log-type';

@Injectable()
export class ScraperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScraperService.name);
  private readonly noticeBatchSize: number;
  private static readonly LOG_RETENTION_DAYS = 14;

  constructor(
    @InjectRepository(NoticeToMariners)
    private readonly ntmRepo: Repository<NoticeToMariners>,
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
    @InjectQueue('scraper')
    private readonly queue: Queue,
    private readonly configService: ConfigService,
  ) {
    this.noticeBatchSize = this.configService.getOrThrow<number>(
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

      const stored = await this.ntmRepo.find({ select: { source: true } });
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
        await this.recordScrapeLog(
          `No new notices to enqueue (${links.length} active, ${storedUrls.size} stored, ${inFlightUrls.size} in flight)`,
        );
        return { message: 'No new notices', enqueued: 0 };
      }

      for (const link of next) {
        await this.queue.add('notice-to-mariners', { url: link.url });
      }

      await this.recordScrapeLog(`Enqueued ${next.length} notice(s)`);
      return { message: 'Enqueued', enqueued: next.length };
    } catch (err) {
      Sentry.captureException(err, {
        tags: { scraper: 'notice-to-mariners' },
      });
      throw err;
    }
  }

  // Audit logs are an unbounded-growth table; trim entries older than the
  // retention window once a day so it stays bounded. Same in-line Sentry
  // capture rationale as scrapeNoticeToMariners.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async pruneOldLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ScraperService.LOG_RETENTION_DAYS);
    try {
      const result = await this.logsRepository.delete({
        createdAt: LessThan(cutoff),
      });
      this.logger.log(
        `Pruned ${result.affected ?? 0} log(s) older than ${ScraperService.LOG_RETENTION_DAYS} days`,
      );
      return { deleted: result.affected ?? 0 };
    } catch (err) {
      Sentry.captureException(err, { tags: { scraper: 'prune-logs' } });
      throw err;
    }
  }

  // Scrape-cycle outcomes go to both the application logger (stdout / log
  // aggregator / Sentry breadcrumbs) and the Logs table (admin audit trail);
  // the two serve different audiences.
  private async recordScrapeLog(description: string) {
    this.logger.log(description);
    const log = this.logsRepository.create({
      logType: LogType.SCRAPING_JOB,
      description,
    });
    await this.logsRepository.save(log);
  }
}
