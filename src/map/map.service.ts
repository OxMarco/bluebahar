import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Weather } from '../scraper/entities/weather.entity';
import { Dataset } from '../scraper/entities/dataset.entity';
import { GetNoticesDto } from './dto/get-notices.dto';

@Injectable()
export class MapService {
  constructor(
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
    @InjectRepository(Weather)
    private readonly weatherRepository: Repository<Weather>,
    @InjectRepository(Dataset)
    private readonly datasetRepository: Repository<Dataset>,
  ) {}

  async getNotices(query: GetNoticesDto, needsReview = false) {
    const now = new Date();
    // needsReview hides notices whose LLM-extracted coordinates failed
    // geo-sanity checks; they're persisted for manual triage but not surfaced.
    const baseWhere = {
      needsReview,
      ...(query.kind ? { kind: query.kind } : {}),
    };

    const where = query.activeOnly
      ? [
          {
            ...baseWhere,
            activeFrom: LessThanOrEqual(now),
            activeTo: MoreThanOrEqual(now),
          },
          {
            ...baseWhere,
            activeFrom: LessThanOrEqual(now),
            activeTo: IsNull(),
          },
        ]
      : baseWhere;

    return this.noticeRepository.find({
      where,
      order: { activeFrom: 'DESC' },
      take: query.limit,
      skip: query.offset,
    });
  }

  async getWeather() {
    return this.weatherRepository.findOne({
      where: {},
      order: { publishTime: 'DESC' },
    });
  }

  async listDatasets() {
    return this.datasetRepository.find({
      select: {
        key: true,
        name: true,
        sourceUrl: true,
        featureCount: true,
        byteSize: true,
        sha256: true,
        fetchedAt: true,
        updatedAt: true,
      },
      order: { name: 'ASC' },
    });
  }

  async getDataset(key: string) {
    return this.datasetRepository.findOne({ where: { key } });
  }
}
