import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import OpenAI from 'openai';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { extractNoticeFromPdf } from './parser/notice-to-mariners';

export type NoticeJobData = { url: string };
export type JobData = NoticeJobData;

@Processor('scraper', { concurrency: 1 })
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);
  private readonly openai: OpenAI;

  constructor(
    config: ConfigService,
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
  ) {
    super();
    this.openai = new OpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
    });
  }

  async process(job: Job<JobData>): Promise<void> {
    switch (job.name) {
      case 'notice-to-mariners':
        await this.handleNoticeToMariners(job);
        return;
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }

  // BullMQ fires 'failed' on every attempt; only escalate to Sentry once retries
  // are exhausted so a flaky job produces one alert, not `attempts` alerts.
  // @sentry/nestjs auto-instruments BullMQ for tracing but does not capture
  // failures as exceptions — that's still on us.
  @OnWorkerEvent('failed')
  onJobFailed(job: Job, err: Error) {
    const maxAttempts = job.opts.attempts ?? 1;
    const terminal = job.attemptsMade >= maxAttempts;
    this.logger.error(
      `Job ${job.name} ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`,
      err.stack,
    );
    if (!terminal) return;
    Sentry.captureException(err, {
      tags: { queue: 'scraper', job: job.name },
      extra: { jobId: job.id, attemptsMade: job.attemptsMade, data: job.data },
    });
  }

  private async handleNoticeToMariners(job: Job<NoticeJobData>) {
    const url = job.data.url;
    this.logger.debug(`Processing notice to mariners at URL ${url}`);

    const parsed = await extractNoticeFromPdf(url, this.openai);

    // A single PDF may yield multiple records (e.g. a VTS notice listing
    // several bunkering areas). Single-statement insert keeps it atomic —
    // partial inserts on retry would collide with unique(source, subKey).
    await this.noticeRepository.insert(parsed);

    // Records that failed geo-sanity / gazetteer lookup are persisted (hidden
    // from public getters) so a human can review them, but we still want a
    // Sentry alert per flagged record so they don't sit unnoticed.
    // captureMessage rather than throw — throwing would mark the job failed
    // and trigger Bull retries against now-existing rows, hitting the
    // unique(source, subKey) constraint.
    const flagged = parsed.filter((p) => p.needsReview);
    for (const p of flagged) {
      this.logger.warn(
        `Notice ${url}${p.subKey ? ` [${p.subKey}]` : ''} flagged for manual review`,
      );
      Sentry.captureMessage('Notice to Mariners flagged for manual review', {
        level: 'warning',
        tags: { scraper: 'notice-to-mariners', kind: p.kind },
        extra: {
          url,
          subKey: p.subKey,
          title: p.title,
          locationLabel: p.locationLabel,
          distance: p.distance,
          depth: p.depth,
          area: p.area,
          areas: p.areas,
        },
      });
    }
    if (flagged.length === 0) {
      this.logger.log(`Stored ${parsed.length} notice(s) from ${url}`);
    }
  }
}
