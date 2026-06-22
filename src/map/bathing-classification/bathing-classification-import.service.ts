import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import OpenAI from 'openai';
import { Logs } from '../../common/entities/logs.entity';
import { LogType } from '../../common/log-type';
import { errorMessage } from '../../common/utils/error-message';
import { DatasetCatalogService } from '../dataset-catalog.service';
import { BathingWaterClassification } from './bathing-classification.entity';
import { type BeachClassification } from './classification';
import { fetchLatestReport } from './report-source';
import { parseClassificationReport } from './report-parse';

// Below this fraction of parsed site codes overlapping the beaches layer we
// assume the wrong PDF was fetched (e.g. a generic profile, not the weekly
// report) and refuse to overwrite good classifications.
const MIN_OVERLAP_RATIO = 0.5;

// Ingests the EHD weekly "Site Classification Update Report" PDF and merges the
// EU water-quality classification onto the beaches layer, keyed by Site_Code.
// The BullMQ processor owns retry behavior; runImport() errors deliberately
// escape so transient failures are retried. Persisted classifications are
// re-applied on boot regardless of whether the network import is enabled, so a
// restart (or an EHD outage) keeps the last good data on the layer.
@Injectable()
export class BathingClassificationImportService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BathingClassificationImportService.name);
  private readonly openai: OpenAI;
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly catalog: DatasetCatalogService,
    @InjectRepository(BathingWaterClassification)
    private readonly repository: Repository<BathingWaterClassification>,
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
  ) {
    this.openai = new OpenAI({ apiKey: config.get<string>('OPENAI_API_KEY') });
    this.enabled =
      config.get<boolean>('BATHING_CLASSIFICATION_IMPORT_ENABLED') ?? false;
  }

  // Re-apply persisted classifications to the beaches layer once the catalog has
  // loaded it (onApplicationBootstrap runs after every onModuleInit). Runs even
  // when the network import is disabled — persistence is the offline fallback.
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.applyPersisted();
    } catch (err) {
      this.logger.error(
        `Failed to apply persisted bathing classifications: ${errorMessage(err)}`,
      );
    }
  }

  // Entry point for the BullMQ processor.
  async importClassifications(): Promise<void> {
    if (!this.enabled) return;
    const summary = await this.runImport();
    await this.recordLog(
      `Imported bathing-water classifications: ${summary.parsed} parsed, ` +
        `${summary.merged} merged onto beaches, ${summary.deleted} stale ` +
        `removed${summary.publishedOn ? ` (published ${summary.publishedOn})` : ''}`,
    );
  }

  private async runImport() {
    // Source URL and parse model are hardcoded (the EHD programme page and the
    // ENRICH_MODEL → OPENAI_MODEL → gpt-5.5 chain); only the enable flag is
    // configurable.
    const report = await fetchLatestReport();
    const parsed = await parseClassificationReport(this.openai, report.pdf);
    this.assertOverlap(parsed.classifications);

    const codes = [...parsed.classifications.keys()];
    // `null` (not undefined) deliberately clears publishedOn when a re-imported
    // report omits it, rather than leaving the prior value. The entity types the
    // column as `string | undefined`, so cast at the upsert like the community
    // -map importer does.
    const rows = [...parsed.classifications.entries()].map(
      ([siteCode, value]) => ({
        siteCode,
        classification: value.classification,
        healthWarning: value.healthWarning,
        publishedOn: value.publishedOn ?? null,
        sourceUrl: report.url,
      }),
    );

    let deleted = 0;
    await this.repository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(BathingWaterClassification);
      await repo.upsert(
        rows as QueryDeepPartialEntity<BathingWaterClassification>[],
        ['siteCode'],
      );
      // The report is the full authoritative snapshot; drop any site no longer
      // listed so a delisted code stops showing a stale classification.
      const result = await repo
        .createQueryBuilder()
        .delete()
        .where('"siteCode" NOT IN (:...codes)', { codes })
        .execute();
      deleted = result.affected ?? 0;
    });

    const { merged } = await this.applyPersisted();
    return {
      parsed: parsed.classifications.size,
      merged,
      deleted,
      publishedOn: parsed.publishedOn,
    };
  }

  // Refuse a report whose site codes barely overlap the beaches layer — a strong
  // signal the wrong PDF was fetched. Skipped when the layer has no codes yet
  // (beaches failed to load), since there's nothing to compare against.
  private assertOverlap(
    classifications: Map<string, BeachClassification>,
  ): void {
    const known = this.catalog.beachSiteCodes();
    if (known.size === 0) return;
    let overlap = 0;
    for (const code of classifications.keys()) {
      if (known.has(code)) overlap += 1;
    }
    const ratio = overlap / classifications.size;
    if (ratio < MIN_OVERLAP_RATIO) {
      throw new Error(
        `Classification report overlaps the beaches layer by only ` +
          `${overlap}/${classifications.size} site(s); refusing to apply ` +
          '(likely the wrong PDF).',
      );
    }
  }

  // Load persisted classifications and push them onto the beaches layer.
  private async applyPersisted(): Promise<{ merged: number }> {
    const rows = await this.repository.find();
    if (rows.length === 0) return { merged: 0 };
    const map = new Map<string, BeachClassification>();
    for (const row of rows) {
      map.set(row.siteCode, {
        classification: row.classification,
        healthWarning: row.healthWarning,
        publishedOn: row.publishedOn,
      });
    }
    const { merged } = this.catalog.setBeachClassifications(map);
    return { merged };
  }

  private async recordLog(description: string) {
    this.logger.log(description);
    const log = this.logsRepository.create({
      logType: LogType.IMPORT_JOB,
      description,
    });
    await this.logsRepository.save(log);
  }
}
