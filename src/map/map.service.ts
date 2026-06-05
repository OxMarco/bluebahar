import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { NoticeKind } from '../scraper/notice-kind';
import { CacheManifestDto } from './dto/cache-manifest.dto';
import { GetNoticesDto } from './dto/get-notices.dto';
import { NoticeMetricsDto } from './dto/notice-metrics.dto';
import { PaginatedNoticesDto } from './dto/paginated-notices.dto';
import { toNoticeDto } from './notice-serializer';
import { toPaginated } from '../common/dto/paginated.dto';
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
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  async getNotices(
    query: GetNoticesDto,
    needsReview = false,
  ): Promise<PaginatedNoticesDto> {
    const now = new Date();
    // needsReview hides notices whose deterministic extraction failed sanity
    // checks; they're persisted for manual triage but not surfaced publicly.
    const kindWhere = query.kind ? { kind: query.kind } : {};
    const where = query.activeOnly
      ? this.activeWhere(needsReview, now, kindWhere)
      : { needsReview, ...kindWhere };

    const entities = await this.noticeRepository.find({
      where,
      order: { activeFrom: 'DESC' },
      take: query.limit + 1,
      skip: query.offset,
    });
    return toPaginated(entities, query.limit, query.offset, toNoticeDto);
  }

  // Cached: the metrics are a fan-out of ~a dozen COUNT queries and the result
  // changes only when the notice set does, so a short TTL spares the DB the
  // repeated scans under polling load. `asOf` reflects when the snapshot was
  // computed, not the request time.
  async getNoticeMetrics(): Promise<NoticeMetricsDto> {
    return this.cache.wrap('map:notice-metrics', () =>
      this.computeNoticeMetrics(),
    );
  }

  private async computeNoticeMetrics(): Promise<NoticeMetricsDto> {
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

  // Cheap change-detection summary. Notices are append-only with a review→public
  // flip and hard deletes — never content edits — so the public set's COUNT plus
  // MAX(createdAt) moves on every change the app can see: a notice approved into
  // public view (count up), a manual add (count + newest createdAt up), or a
  // delete (count down). Expiry is left out by design — it's deterministic, so
  // the app drops lapsed notices itself using `nextExpiryAt` rather than polling.
  async getManifest(): Promise<CacheManifestDto> {
    return this.cache.wrap('map:manifest', () => this.computeManifest());
  }

  private async computeManifest(): Promise<CacheManifestDto> {
    const now = new Date();
    const [summary, expiry] = await Promise.all([
      this.noticeRepository
        .createQueryBuilder('n')
        .select('COUNT(*)', 'count')
        .addSelect('MAX(n.createdAt)', 'maxCreatedAt')
        .where('n.needsReview = :needsReview', { needsReview: false })
        .getRawOne<{ count: string; maxCreatedAt: Date | string | null }>(),
      this.noticeRepository
        .createQueryBuilder('n')
        .select('MIN(n.activeTo)', 'nextExpiry')
        .where('n.needsReview = :needsReview', { needsReview: false })
        .andWhere('n.activeFrom <= :now', { now })
        .andWhere('n.activeTo > :now', { now })
        .getRawOne<{ nextExpiry: Date | string | null }>(),
    ]);

    const noticesRev = createHash('sha256')
      .update(`${summary?.count ?? '0'}:${toIso(summary?.maxCreatedAt) ?? '0'}`)
      .digest('hex');

    return {
      datasets: { rev: this.datasets.revision() },
      notices: {
        rev: noticesRev,
        nextExpiryAt: toIso(expiry?.nextExpiry),
      },
    };
  }

  listDatasets(): DatasetMetadata[] {
    return this.datasets.list();
  }

  // Opaque content-hash of the served catalog; used as the dataset list's ETag.
  datasetsRevision(): string {
    return this.datasets.revision();
  }

  requireDataset(key: string): DatasetEntry {
    return this.datasets.requireEntry(key);
  }

  // The "active now" filter as a TypeORM OR (array): activeFrom in the past and
  // activeTo either still ahead or open-ended. `extra` merges in any additional
  // equality filters (e.g. kind) onto both branches.
  private activeWhere(needsReview: boolean, now: Date, extra: object = {}) {
    return [
      {
        ...extra,
        needsReview,
        activeFrom: LessThanOrEqual(now),
        activeTo: MoreThanOrEqual(now),
      },
      {
        ...extra,
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

// Raw aggregate columns come back as a Date (pg driver) or string depending on
// the path; normalize both to an ISO string, or null when absent/invalid.
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
