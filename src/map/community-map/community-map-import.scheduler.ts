import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as Sentry from '@sentry/nestjs';
import type { Queue } from 'bullmq';
import { errorMessage } from '../../common/utils/error-message';

export const COMMUNITY_MAP_IMPORT_QUEUE = 'community-map-import';
export const COMMUNITY_MAP_IMPORT_JOB = 'sync';

@Injectable()
export class CommunityMapImportScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CommunityMapImportScheduler.name);
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    @InjectQueue(COMMUNITY_MAP_IMPORT_QUEUE) private readonly queue: Queue,
  ) {
    this.enabled = config.get<boolean>('COMMUNITY_MAP_IMPORT_ENABLED') ?? true;
  }

  onApplicationBootstrap(): void {
    void this.enqueue().catch((error: unknown) => {
      this.logger.error(
        `Failed to enqueue bootstrap community-map import: ${errorMessage(error)}`,
      );
      Sentry.captureException(error, {
        tags: { importer: 'community-map-import', phase: 'bootstrap-enqueue' },
      });
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async enqueue(now = new Date()): Promise<void> {
    if (!this.enabled) return;
    await this.queue.add(
      COMMUNITY_MAP_IMPORT_JOB,
      {},
      { jobId: communityMapImportJobId(now) },
    );
  }
}

export function communityMapImportJobId(now: Date): string {
  return `community-map-import-${now.toISOString().slice(0, 10)}`;
}
