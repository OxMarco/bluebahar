import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import * as Sentry from '@sentry/nestjs';
import type { Job } from 'bullmq';
import { BathingClassificationImportService } from './bathing-classification-import.service';
import {
  BATHING_CLASSIFICATION_JOB,
  BATHING_CLASSIFICATION_QUEUE,
} from './bathing-classification.scheduler';

@Processor(BATHING_CLASSIFICATION_QUEUE, { concurrency: 1 })
export class BathingClassificationProcessor extends WorkerHost {
  private readonly logger = new Logger(BathingClassificationProcessor.name);

  constructor(private readonly importer: BathingClassificationImportService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== BATHING_CLASSIFICATION_JOB) {
      throw new Error(`Unknown bathing-classification import job: ${job.name}`);
    }
    await this.importer.importClassifications();
  }

  @OnWorkerEvent('failed')
  onJobFailed(job: Job, error: Error): void {
    const maxAttempts = job.opts.attempts ?? 1;
    this.logger.error(
      `Bathing-classification import ${job.id ?? '(no id)'} failed ` +
        `(attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      error.stack,
    );
    // Only alert once retries are exhausted — a flaky/blocked upstream is
    // expected noise that resolves on its own.
    if (job.attemptsMade >= maxAttempts) {
      Sentry.captureException(error, {
        tags: {
          importer: 'bathing-classification-import',
          jobId: job.id ?? '(no id)',
        },
      });
    }
  }
}
