import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { GetNoticesDto } from './dto/get-notices.dto';
import {
  DatasetCatalogService,
  type DatasetEntry,
  type DatasetMetadata,
} from './dataset-catalog.service';

@Injectable()
export class MapService {
  constructor(
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
    private readonly datasets: DatasetCatalogService,
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

  listDatasets(): DatasetMetadata[] {
    return this.datasets.list();
  }

  getDataset(key: string): DatasetEntry | undefined {
    return this.datasets.get(key);
  }
}
