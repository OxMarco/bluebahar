import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Job } from 'bullmq';
import * as Sentry from '@sentry/nestjs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import OpenAI from 'openai';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { Weather } from './entities/weather.entity';
import { Dataset } from './entities/dataset.entity';
import { extractNoticeFromPdf } from './parser/notice-to-mariners';
import { fetchMarinerForecast } from './parser/weather';
import { fetchWfsDataset } from './parser/wfs';
import { DATASETS } from './datasets';

export type NoticeJobData = { url: string };
export type WeatherJobData = Record<string, never>;
export type DatasetJobData = { key: string };
export type JobData = NoticeJobData | WeatherJobData | DatasetJobData;

@Processor('scraper', { concurrency: 1 })
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);
  private readonly openai: OpenAI;
  private readonly datasetsDir: string;

  constructor(
    config: ConfigService,
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
    @InjectRepository(Weather)
    private readonly weatherRepository: Repository<Weather>,
    @InjectRepository(Dataset)
    private readonly datasetRepository: Repository<Dataset>,
  ) {
    super();
    this.openai = new OpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
    });
    this.datasetsDir = config.getOrThrow<string>('DATASETS_STORAGE_DIR');
  }

  async process(job: Job<JobData>): Promise<void> {
    switch (job.name) {
      case 'notice-to-mariners':
        await this.handleNoticeToMariners(job as Job<NoticeJobData>);
        return;
      case 'weather':
        await this.handleWeather();
        return;
      case 'dataset':
        await this.handleDataset(job as Job<DatasetJobData>);
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

    await this.noticeRepository.insert({
      ...parsed,
    });

    // Notices that fail geo-sanity checks are persisted (hidden from public
    // getters) so a human can review them, but we still want a Sentry alert
    // so they don't sit unnoticed. captureMessage rather than throw — throwing
    // would mark the job failed and trigger Bull retries against the now-
    // existing row, hitting the unique(source) constraint.
    if (parsed.needsReview) {
      this.logger.warn(`Notice ${url} flagged for manual review`);
      Sentry.captureMessage('Notice to Mariners flagged for manual review', {
        level: 'warning',
        tags: { scraper: 'notice-to-mariners', kind: parsed.kind },
        extra: {
          url,
          title: parsed.title,
          locationLabel: parsed.locationLabel,
          area: parsed.area,
        },
      });
    } else {
      this.logger.log(`Stored notice ${url}`);
    }
  }

  private async handleWeather() {
    this.logger.debug('Fetching mariner weather forecast');

    const parsed = await fetchMarinerForecast();

    const existing = await this.weatherRepository.findOne({
      where: { externalId: parsed.externalId },
      select: { id: true },
    });
    if (existing) {
      this.logger.log(
        `Weather forecast ${parsed.externalId} already stored, skipping`,
      );
      return;
    }

    await this.weatherRepository.insert({ ...parsed });
    this.logger.log(`Stored weather forecast ${parsed.externalId}`);
  }

  private async handleDataset(job: Job<DatasetJobData>) {
    const { key } = job.data;
    const definition = DATASETS.find((d) => d.key === key);
    if (!definition) {
      throw new Error(`Unknown dataset key: ${key}`);
    }

    this.logger.debug(`Fetching dataset ${key}`);
    const fetched = await fetchWfsDataset(definition.url);

    const existing = await this.datasetRepository.findOne({ where: { key } });
    const filePath = resolve(join(this.datasetsDir, `${key}.geojson`));
    const fileOnDisk = await access(filePath).then(
      () => true,
      () => false,
    );

    if (existing && existing.sha256 === fetched.sha256 && fileOnDisk) {
      this.logger.log(
        `Dataset ${key} unchanged (sha256 ${fetched.sha256.slice(0, 12)})`,
      );
      return;
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, fetched.geojson, 'utf8');

    const fetchedAt = new Date();
    if (existing) {
      await this.datasetRepository.update(
        { id: existing.id },
        {
          name: definition.name,
          sourceUrl: definition.url,
          filePath,
          sha256: fetched.sha256,
          featureCount: fetched.featureCount,
          byteSize: fetched.byteSize,
          fetchedAt,
        },
      );
      this.logger.log(
        `Updated dataset ${key} (${fetched.featureCount} features, ${fetched.byteSize} bytes)`,
      );
    } else {
      await this.datasetRepository.insert({
        key,
        name: definition.name,
        sourceUrl: definition.url,
        filePath,
        sha256: fetched.sha256,
        featureCount: fetched.featureCount,
        byteSize: fetched.byteSize,
        fetchedAt,
      });
      this.logger.log(
        `Stored dataset ${key} (${fetched.featureCount} features, ${fetched.byteSize} bytes)`,
      );
    }
  }
}
