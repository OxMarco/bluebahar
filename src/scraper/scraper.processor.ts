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
import {
  extractNoticeFromPdf,
  flagInvalidNotices,
} from './parser/notice-to-mariners';
import { LogType } from './log-type';

type NoticeJobData = { url: string; title?: string };

@Processor('scraper', { concurrency: 1 })
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);
  private readonly openai: OpenAI;
  private readonly enrichModel?: string;
  private readonly visionVerify: boolean;
  private readonly visionModel?: string;

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
    this.enrichModel =
      config.get<string>('ENRICH_MODEL') ?? config.get<string>('OPENAI_MODEL');
    this.visionVerify = config.get<boolean>('VISION_VERIFY') ?? true;
    this.visionModel = config.get<string>('VISION_MODEL') ?? this.enrichModel;
  }

  async process(job: Job<NoticeJobData>): Promise<void> {
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

    const parsed = await extractNoticeFromPdf(url, this.openai, {
      listingTitle: job.data.title,
      enrichModel: this.enrichModel,
      visionVerify: this.visionVerify,
      visionModel: this.visionModel,
    });

    // The extractor currently always yields one record (already-expired notices
    // included — they're persisted so their URL dedups out of future scrape
    // cycles); the guard only protects insert([]) if that ever changes.
    if (parsed.length === 0) {
      this.logger.log(`Nothing extracted from notice at URL ${url}`);
      return;
    }

    // Structural-integrity gate at the DB boundary: validate every record as a
    // well-formed ParsedNotice regardless of which extraction branch produced
    // each field (deterministic regex, listing anchor, or AI enrichment — only
    // the last was previously schema-checked). Rather than reject a malformed
    // record — which would discard a possibly safety-critical notice — failures
    // are folded into needsReview so the record is still persisted but hidden
    // from public getters until a human curates it (and Sentry-alerted below).
    const records = flagInvalidNotices(parsed);

    // ON CONFLICT DO NOTHING on unique(source, subKey) makes the job
    // idempotent: if the insert lands but a later step throws, the BullMQ
    // retry re-runs the whole handler and must not die on duplicate keys.
    // (Today each PDF yields exactly one record; the array shape is the
    // extension point for per-section splitting.)
    await this.noticeRepository
      .createQueryBuilder()
      .insert()
      .values(records)
      .orIgnore()
      .execute();

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
    const flagged = records.filter((p) => p.needsReview);
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
      this.logger.log(`Stored ${records.length} notice(s) from ${url}`);
    }

    // Public (non-flagged) notices with no geometry get served to the app with
    // geometry: null, so they drop no map pin and the mariner can't tap them.
    // Often legitimate (a notice that names no location), but worth counting so
    // we can tell genuine location-less notices from extraction gaps.
    const noGeometry = records.filter(
      (p) => !p.needsReview && p.areas.length === 0,
    );
    if (noGeometry.length > 0) {
      this.logger.warn(
        `${noGeometry.length}/${records.length} notice(s) from ${url} stored without geometry (no map pin)`,
      );
    }
  }
}
