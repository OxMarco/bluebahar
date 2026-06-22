import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import type { Queue } from 'bullmq';
import { errorMessage } from '../../common/utils/error-message';

export const BATHING_CLASSIFICATION_QUEUE = 'bathing-classification-import';
export const BATHING_CLASSIFICATION_JOB = 'sync';

// Schedules the weekly classification import. Defaults disabled: the EHD source
// may be unreachable from the deployment, so an operator opts in once they've
// confirmed access (or set BATHING_CLASSIFICATION_REPORT_URL).
@Injectable()
export class BathingClassificationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BathingClassificationScheduler.name);
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    @InjectQueue(BATHING_CLASSIFICATION_QUEUE) private readonly queue: Queue,
  ) {
    this.enabled =
      config.get<boolean>('BATHING_CLASSIFICATION_IMPORT_ENABLED') ?? false;
  }

  onApplicationBootstrap(): void {
    void this.enqueue().catch((error: unknown) => {
      this.logger.error(
        `Failed to enqueue bootstrap bathing-classification import: ${errorMessage(error)}`,
      );
      Sentry.captureException(error, {
        tags: {
          importer: 'bathing-classification-import',
          phase: 'bootstrap-enqueue',
        },
      });
    });
  }

  // The report is published weekly, but a daily tick is cheap (idempotent jobId)
  // and lets a republished/corrected report land within a day.
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async enqueue(now = new Date()): Promise<void> {
    if (!this.enabled) return;
    await this.queue.add(
      BATHING_CLASSIFICATION_JOB,
      {},
      { jobId: bathingClassificationJobId(now) },
    );
  }
}

export function bathingClassificationJobId(now: Date): string {
  return `bathing-classification-import-${now.toISOString().slice(0, 10)}`;
}
