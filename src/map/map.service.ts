import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { IsNull, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { createHash } from 'node:crypto';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { UserReport } from './entities/user-report.entity';
import { NoticeKind } from '../scraper/notice-kind';
import { CacheManifestDto } from './dto/cache-manifest.dto';
import { CreateReportDto } from './dto/create-report.dto';
import { GetNoticesDto } from './dto/get-notices.dto';
import { NoticeMetricsDto } from './dto/notice-metrics.dto';
import { PaginatedNoticesDto } from './dto/paginated-notices.dto';
import { toNoticeDto } from './notice-serializer';
import { containsSwearWord } from './report-spam-filter';
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
    @InjectRepository(UserReport)
    private readonly reportRepository: Repository<UserReport>,
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

  // Cached: the result changes only when the notice set does, so a short TTL
  // spares the DB repeated scans under polling load. `asOf` reflects when the
  // snapshot was computed, not the request time.
  async getNoticeMetrics(): Promise<NoticeMetricsDto> {
    return this.cache.wrap('map:notice-metrics', () =>
      this.computeNoticeMetrics(),
    );
  }

  // Two GROUP BY queries yield every number (totals are sums): one over
  // (kind, needsReview) for the breakdown, one over needsReview restricted to
  // the active window.
  private async computeNoticeMetrics(): Promise<NoticeMetricsDto> {
    const now = new Date();
    const [kindRows, activeRows] = await Promise.all([
      this.noticeRepository
        .createQueryBuilder('n')
        .select('n.kind', 'kind')
        .addSelect('n.needsReview', 'needsReview')
        .addSelect('COUNT(*)', 'count')
        .groupBy('n.kind')
        .addGroupBy('n.needsReview')
        .getRawMany<{
          kind: NoticeKind;
          needsReview: boolean;
          count: string;
        }>(),
      this.noticeRepository
        .createQueryBuilder('n')
        .select('n.needsReview', 'needsReview')
        .addSelect('COUNT(*)', 'count')
        .where('n.activeFrom <= :now', { now })
        .andWhere('(n.activeTo >= :now OR n.activeTo IS NULL)', { now })
        .groupBy('n.needsReview')
        .getRawMany<{ needsReview: boolean; count: string }>(),
    ]);

    const byKind = new Map<
      NoticeKind,
      { publicCount: number; needsReviewCount: number }
    >();
    for (const row of kindRows) {
      const entry = byKind.get(row.kind) ?? {
        publicCount: 0,
        needsReviewCount: 0,
      };
      if (row.needsReview) entry.needsReviewCount += Number(row.count);
      else entry.publicCount += Number(row.count);
      byKind.set(row.kind, entry);
    }
    const publicCount = sumBy(kindRows, (r) => !r.needsReview);
    const needsReviewCount = sumBy(kindRows, (r) => r.needsReview);

    return {
      asOf: now.toISOString(),
      total: publicCount + needsReviewCount,
      publicCount,
      needsReviewCount,
      activePublicCount: sumBy(activeRows, (r) => !r.needsReview),
      activeNeedsReviewCount: sumBy(activeRows, (r) => r.needsReview),
      byKind: Object.values(NoticeKind).map((kind) => {
        const counts = byKind.get(kind) ?? {
          publicCount: 0,
          needsReviewCount: 0,
        };
        return {
          kind,
          total: counts.publicCount + counts.needsReviewCount,
          ...counts,
        };
      }),
    };
  }

  // Cheap change-detection summary. The public set's COUNT plus MAX(updatedAt)
  // moves on every change the app can see: an approval flips needsReview
  // (touching updatedAt — createdAt would miss it, so offsetting delete+approve
  // pairs between polls could collide), a manual add bumps both, a delete drops
  // the count. Expiry is left out by design — it's deterministic, so the app
  // drops lapsed notices itself using `nextExpiryAt` rather than polling.
  async getManifest(): Promise<CacheManifestDto> {
    return this.cache.wrap('map:manifest', () => this.computeManifest());
  }

  private async computeManifest(): Promise<CacheManifestDto> {
    const now = new Date();
    const [summary, expiry] = await Promise.all([
      this.noticeRepository
        .createQueryBuilder('n')
        .select('COUNT(*)', 'count')
        .addSelect('MAX(n.updatedAt)', 'maxUpdatedAt')
        .where('n.needsReview = :needsReview', { needsReview: false })
        .getRawOne<{ count: string; maxUpdatedAt: Date | string | null }>(),
      this.noticeRepository
        .createQueryBuilder('n')
        .select('MIN(n.activeTo)', 'nextExpiry')
        .where('n.needsReview = :needsReview', { needsReview: false })
        .andWhere('n.activeFrom <= :now', { now })
        .andWhere('n.activeTo > :now', { now })
        .getRawOne<{ nextExpiry: Date | string | null }>(),
    ]);

    const noticesRev = createHash('sha256')
      .update(`${summary?.count ?? '0'}:${toIso(summary?.maxUpdatedAt) ?? '0'}`)
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

  // Persists a user-submitted report against a tapped point unless the spam
  // filter rejects it. The body is admin-only, so nothing else is echoed back.
  async createReport(
    dto: CreateReportDto,
  ): Promise<{ accepted: true; id: string } | { accepted: false }> {
    if (containsSwearWord(dto.title, dto.description)) {
      return { accepted: false };
    }

    const saved = await this.reportRepository.save(
      this.reportRepository.create(dto),
    );
    return { accepted: true, id: saved.id };
  }
}

function sumBy(
  rows: { needsReview: boolean; count: string }[],
  match: (row: { needsReview: boolean }) => boolean,
): number {
  return rows.filter(match).reduce((acc, row) => acc + Number(row.count), 0);
}

// Raw aggregate columns come back as a Date (pg driver) or string depending on
// the path; normalize both to an ISO string, or null when absent/invalid.
function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
