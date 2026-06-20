import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';
import { CommunityMapImportService } from './community-map-import.service';
import {
  COMMUNITY_MAP_IMPORT_JOB,
  COMMUNITY_MAP_IMPORT_QUEUE,
} from './community-map-import.scheduler';

@Processor(COMMUNITY_MAP_IMPORT_QUEUE, { concurrency: 1 })
export class CommunityMapImportProcessor extends WorkerHost {
  private readonly logger = new Logger(CommunityMapImportProcessor.name);

  constructor(private readonly importer: CommunityMapImportService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== COMMUNITY_MAP_IMPORT_JOB) {
      throw new Error(`Unknown community-map import job: ${job.name}`);
    }
    await this.importer.importCommunityMap();
  }

  @OnWorkerEvent('failed')
  onJobFailed(job: Job, error: Error): void {
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.error(
      `Community-map import ${job.id ?? '(no id)'} failed ` +
        `(attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      error.stack,
    );
    // Only alert once retries are exhausted — intermediate retry failures are
    // expected noise for a flaky upstream and resolve on their own.
    if (job.attemptsMade >= maxAttempts) {
      Sentry.captureException(error, {
        tags: { importer: 'community-map-import', jobId: job.id ?? '(no id)' },
      });
    }
  }
}
