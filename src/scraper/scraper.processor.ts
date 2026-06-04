import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import OpenAI from 'openai';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { Logs } from './entities/logs.entity';
import { extractNoticeFromPdf } from './parser/notice-to-mariners';
import { LogType } from './log-type';

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
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
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

  // BullMQ fires 'failed' on every attempt. @sentry/nestjs already captures
  // thrown process() failures; this hook keeps the worker logs informative.
  @OnWorkerEvent('failed')
  onJobFailed(job: Job, err: Error) {
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.error(
      `Job ${job.name} ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${err.message}`,
      err.stack,
    );
  }

  private async handleNoticeToMariners(job: Job<NoticeJobData>) {
    const url = job.data.url;
    this.logger.debug(`Processing notice to mariners at URL ${url}`);

    const parsed = await extractNoticeFromPdf(url, this.openai);

    // Empty result means the notice's validity window has already lapsed and
    // the extractor skipped it — nothing to store. (insert([]) would also throw.)
    if (parsed.length === 0) {
      this.logger.log(`Skipped already-expired notice at URL ${url}`);
      return;
    }

    // A single PDF may yield multiple records (e.g. a VTS notice listing
    // several bunkering areas). Single-statement insert keeps it atomic —
    // partial inserts on retry would collide with unique(source, subKey).
    await this.noticeRepository.insert(parsed);

    const log = this.logsRepository.create({
      logType: LogType.NEW_NTM_AUTO,
      description: `Added new NtM record sourced from URL ${url}`,
    });
    await this.logsRepository.save(log);

    // Records that failed extraction sanity checks are persisted (hidden
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
      // Identifier-only payload — reviewer pulls the full row from the DB
      // via (source, subKey). Avoids shipping coordinate arrays to Sentry.
      Sentry.captureMessage('Notice to Mariners flagged for manual review', {
        level: 'warning',
        tags: { scraper: 'notice-to-mariners', kind: p.kind },
        extra: {
          url,
          subKey: p.subKey,
          title: p.title,
          reviewReasons: p.reviewReasons,
        },
      });
    }
    if (flagged.length === 0) {
      this.logger.log(`Stored ${parsed.length} notice(s) from ${url}`);
    }
  }
}
