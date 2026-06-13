import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { UserReport } from '../map/entities/user-report.entity';
import { Logs } from '../scraper/entities/logs.entity';
import { LogType } from '../scraper/log-type';
import { MapService } from '../map/map.service';
import { GetNoticesDto } from '../map/dto/get-notices.dto';
import { toNoticeDto } from '../map/notice-serializer';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { ViewLogsDto } from './dto/view-logs.dto';
import { ViewFlaggedDto } from './dto/view-flagged.dto';
import { ViewReportsDto } from './dto/view-reports.dto';
import { PaginatedLogsDto } from './dto/paginated-logs.dto';
import { PaginatedFlaggedNoticesDto } from './dto/flagged-notice.dto';
import { Paginated, toPaginated } from '../common/dto/paginated.dto';

@Injectable()
export class AdminService {
  constructor(
    @InjectRepository(NoticeToMariners)
    private readonly noticeRepository: Repository<NoticeToMariners>,
    @InjectRepository(UserReport)
    private readonly reportRepository: Repository<UserReport>,
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
    private readonly mapService: MapService,
  ) {}

  async viewLogs(query: ViewLogsDto): Promise<PaginatedLogsDto> {
    const { logType, since, limit, offset } = query;
    const entities = await this.logsRepository.find({
      where: {
        ...(logType ? { logType } : {}),
        ...(since ? { createdAt: MoreThanOrEqual(since) } : {}),
      },
      order: { createdAt: 'DESC' },
      take: limit + 1,
      skip: offset,
    });
    return toPaginated(entities, limit, offset);
  }

  async viewFlaggedNotices(
    query: ViewFlaggedDto,
  ): Promise<PaginatedFlaggedNoticesDto> {
    const { minReports, limit, offset } = query;
    const entities = await this.noticeRepository.find({
      where: { reports: MoreThanOrEqual(minReports) },
      // createdAt tiebreaker keeps offset pagination stable when many rows
      // share a report count.
      order: { reports: 'DESC', createdAt: 'DESC' },
      take: limit + 1,
      skip: offset,
    });
    return toPaginated(entities, limit, offset, (entity) => ({
      ...toNoticeDto(entity),
      reports: entity.reports,
    }));
  }

  async viewNoticesInReview(query: GetNoticesDto) {
    return this.mapService.getNotices(query, true);
  }

  // Crowd-sourced reports for the admin queue. Defaults to open (unresolved)
  // ones, newest first; createdAt is unique enough to keep offset paging stable.
  async viewReports(query: ViewReportsDto): Promise<Paginated<UserReport>> {
    const { resolved, limit, offset } = query;
    const entities = await this.reportRepository.find({
      where: { resolved },
      order: { createdAt: 'DESC' },
      take: limit + 1,
      skip: offset,
    });
    return toPaginated(entities, limit, offset);
  }

  // Marks a report actioned without deleting it (kept for audit). Idempotent —
  // re-resolving an already-resolved report still reports "affected".
  async resolveReport(id: string) {
    const result = await this.reportRepository.update(id, { resolved: true });
    this.assertReportAffected(result, id);
  }

  async deleteReport(id: string) {
    const result = await this.reportRepository.delete(id);
    this.assertReportAffected(result, id);
  }

  // Clears the extraction review flag, making the notice public. This is
  // independent of user reports — use dismissReports to deal with those.
  async approveNtM(id: string) {
    const result = await this.noticeRepository.update(id, {
      needsReview: false,
      reviewReasons: [],
    });
    this.assertNoticeAffected(result, id);
  }

  // Resets the crowd-sourced report counter (e.g. after confirming the notice
  // is still accurate). Distinct from approveNtM, which clears the extraction
  // review flag.
  async dismissReports(id: string) {
    const result = await this.noticeRepository.update(id, { reports: 0 });
    this.assertNoticeAffected(result, id);
  }

  async rejectNtM(id: string) {
    const result = await this.noticeRepository.delete(id);
    this.assertNoticeAffected(result, id);
  }

  async addNtm(dto: CreateNoticeDto) {
    // Manually entered by an admin, so it skips the geo-sanity review queue.
    const notice = this.noticeRepository.create({ ...dto, needsReview: false });
    const saved = await this.noticeRepository.save(notice);

    const log = this.logsRepository.create({
      logType: LogType.NEW_NTM_MANUAL,
      description: `Added new NtM record ${saved.id} (${saved.title})`,
    });
    await this.logsRepository.save(log);

    return saved;
  }

  private assertNoticeAffected(
    result: { affected?: number | null },
    id: string,
  ) {
    if (!result.affected) {
      throw new NotFoundException({
        error: `notice to mariners with id ${id} not found`,
      });
    }
  }

  private assertReportAffected(
    result: { affected?: number | null },
    id: string,
  ) {
    if (!result.affected) {
      throw new NotFoundException({
        error: `user report with id ${id} not found`,
      });
    }
  }
}
