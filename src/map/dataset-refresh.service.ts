import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as Sentry from '@sentry/nestjs';
import { fetchText } from '../common/utils/http';
import { Logs } from '../common/entities/logs.entity';
import { LogType } from '../common/log-type';
import { DatasetCatalogService } from './dataset-catalog.service';
import { DATASETS, type DatasetDefinition } from './datasets';
import { errorMessage } from '../common/utils/error-message';

// Some catalogue layers (bathing-water quality) change on a daily cadence, so
// unlike the hand-refreshed multi-year layers we re-fetch them from upstream.
// The committed data/datasets/{key}.geojson is the boot-time seed and the
// fallback when upstream is unreachable; this service swaps the in-memory entry
// for fresher data once it lands. It never touches the seed file on disk — the
// refresh is purely in-memory, so a restart falls back to the seed and the next
// run re-fetches.
@Injectable()
export class DatasetRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatasetRefreshService.name);

  constructor(
    private readonly catalog: DatasetCatalogService,
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
  ) {}

  // Runs after DatasetCatalogService has loaded the seed files — its hook is
  // onModuleInit, and Nest completes all onModuleInit hooks before any
  // onApplicationBootstrap — so a fresh deploy serves up-to-date data within
  // seconds instead of waiting for the first cron tick. Fire-and-forget: the
  // seed already covers every layer, so startup must not block on (or fail
  // with) an upstream fetch. refreshOne() catches and reports per-dataset
  // errors, so this promise never rejects.
  onApplicationBootstrap() {
    void this.refreshLiveDatasets();
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshLiveDatasets() {
    const live = DATASETS.filter((d) => d.refresh === 'daily');
    for (const def of live) {
      await this.refreshOne(def);
    }
  }

  private async refreshOne(def: DatasetDefinition) {
    try {
      const raw = await fetchText(
        def.sourceUrl,
        def.fetchHeaders ? { headers: def.fetchHeaders } : undefined,
      );
      const metadata = this.catalog.refreshEntry(def, raw);
      await this.recordLog(
        `Refreshed dataset "${def.key}" (${metadata.featureCount} feature(s))`,
      );
    } catch (err) {
      // Keep serving the previous entry (seed or last good fetch) — a flaky
      // upstream shouldn't blank out a live layer. One Sentry alert per failure.
      const message = errorMessage(err);
      this.logger.error(
        `Failed to refresh dataset "${def.key}" from ${def.sourceUrl}: ${message}`,
      );
      Sentry.captureException(err, {
        tags: { importer: 'dataset-refresh', dataset: def.key },
      });
    }
  }

  // Import outcomes refresh outcomes go to both stdout and the Logs
  // table so they surface in the admin audit trail.
  private async recordLog(description: string) {
    this.logger.log(description);
    const log = this.logsRepository.create({
      logType: LogType.IMPORT_JOB,
      description,
    });
    await this.logsRepository.save(log);
  }
}
