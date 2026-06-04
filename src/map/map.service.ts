import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { NoticeKind } from '../scraper/notice-kind';
import { GetNoticesDto } from './dto/get-notices.dto';
import { NoticeMetricsDto } from './dto/notice-metrics.dto';
import { PaginatedNoticesDto } from './dto/paginated-notices.dto';
import { toNoticeDto } from './notice-serializer';
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

  async getNotices(
    query: GetNoticesDto,
    needsReview = false,
  ): Promise<PaginatedNoticesDto> {
    const now = new Date();
    // needsReview hides notices whose deterministic extraction failed sanity
    // checks; they're persisted for manual triage but not surfaced publicly.
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

    const entities = await this.noticeRepository.find({
      where,
      order: { activeFrom: 'DESC' },
      take: query.limit + 1,
      skip: query.offset,
    });
    const hasMore = entities.length > query.limit;
    const items = entities.slice(0, query.limit).map(toNoticeDto);
    return {
      items,
      limit: query.limit,
      offset: query.offset,
      hasMore,
    };
  }

  async getNoticeMetrics(): Promise<NoticeMetricsDto> {
    const now = new Date();
    const [
      total,
      publicCount,
      needsReviewCount,
      activePublicCount,
      activeNeedsReviewCount,
      ...kindCounts
    ] = await Promise.all([
      this.noticeRepository.count(),
      this.noticeRepository.count({ where: { needsReview: false } }),
      this.noticeRepository.count({ where: { needsReview: true } }),
      this.noticeRepository.count({
        where: this.activeWhere(false, now),
      }),
      this.noticeRepository.count({
        where: this.activeWhere(true, now),
      }),
      ...Object.values(NoticeKind).flatMap((kind) => [
        this.noticeRepository.count({ where: { kind } }),
        this.noticeRepository.count({ where: { kind, needsReview: false } }),
        this.noticeRepository.count({ where: { kind, needsReview: true } }),
      ]),
    ]);

    return {
      asOf: now.toISOString(),
      total,
      publicCount,
      needsReviewCount,
      activePublicCount,
      activeNeedsReviewCount,
      byKind: Object.values(NoticeKind).map((kind, index) => ({
        kind,
        total: kindCounts[index * 3] ?? 0,
        publicCount: kindCounts[index * 3 + 1] ?? 0,
        needsReviewCount: kindCounts[index * 3 + 2] ?? 0,
      })),
    };
  }

  listDatasets(): DatasetMetadata[] {
    return this.datasets.list();
  }

  requireDataset(key: string): DatasetEntry {
    return this.datasets.requireEntry(key);
  }

  private activeWhere(needsReview: boolean, now: Date) {
    return [
      {
        needsReview,
        activeFrom: LessThanOrEqual(now),
        activeTo: MoreThanOrEqual(now),
      },
      {
        needsReview,
        activeFrom: LessThanOrEqual(now),
        activeTo: IsNull(),
      },
    ];
  }

  async report(id: string) {
    // Atomic increment so concurrent reports don't clobber each other (a
    // read-modify-write would lose increments under load). `increment` returns
    // the affected-row count, which doubles as the existence check.
    const result = await this.noticeRepository.increment({ id }, 'reports', 1);
    if (!result.affected)
      throw new NotFoundException({
        error: `notice to mariners with id ${id} not found`,
      });
  }
}
