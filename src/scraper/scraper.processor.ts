import { Process, Processor } from '@nestjs/bull';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import type { Job } from 'bull';
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

@Processor('scraper')
export class ScraperProcessor {
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
    this.openai = new OpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
    });
    this.datasetsDir = config.getOrThrow<string>('DATASETS_STORAGE_DIR');
  }

  @Process({ name: 'notice-to-mariners', concurrency: 1 })
  async handleNoticeToMariners(job: Job<NoticeJobData>) {
    const url = job.data.url;
    this.logger.debug(`Processing notice to mariners at URL ${url}`);

    const parsed = await extractNoticeFromPdf(url, this.openai);

    await this.noticeRepository.insert({
      ...parsed,
    });

    this.logger.log(`Stored notice ${url}`);
  }

  @Process({ name: 'weather', concurrency: 1 })
  async handleWeather() {
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

  @Process({ name: 'dataset', concurrency: 2 })
  async handleDataset(job: Job<DatasetJobData>) {
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
