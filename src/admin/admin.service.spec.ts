import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AdminService } from './admin.service';
import { NoticeToMariners } from '../map/entities/notice-to-mariners.entity';
import { UserReport } from '../map/entities/user-report.entity';
import { Logs } from '../common/entities/logs.entity';
import { LogType } from '../common/log-type';
import { NoticeKind } from '../map/notice-kind';
import { MapService } from '../map/map.service';
import type { CreateNoticeDto } from './dto/create-notice.dto';

function makeNotice(
  overrides: Partial<NoticeToMariners> = {},
): NoticeToMariners {
  const notice = new NoticeToMariners();
  Object.assign(notice, {
    id: '0f1e8f1e-9b91-4f59-bb4f-a82d06e4f950',
    kind: NoticeKind.ALERT,
    title: 'Temporary works',
    description: 'Works in progress.',
    source: 'https://example.com/notice.pdf',
    subKey: '',
    areas: [
      {
        label: 'Work area',
        geometryType: 'point',
        points: [{ lat: 35.9, long: 14.5 }],
      },
    ],
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    activeFrom: new Date('2026-01-02T00:00:00.000Z'),
    needsReview: false,
    reports: 0,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
  });
  return notice;
}

function makeReport(overrides: Partial<UserReport> = {}): UserReport {
  const report = new UserReport();
  Object.assign(report, {
    id: '3e8c2c25-f11b-42d1-a5a6-47694493b3c4',
    title: 'Wreck marker missing',
    description: 'The marker is no longer visible from the approach.',
    latitude: 35.9,
    longitude: 14.5,
    resolved: false,
    createdAt: new Date('2026-01-04T00:00:00.000Z'),
    updatedAt: new Date('2026-01-04T00:00:00.000Z'),
    ...overrides,
  });
  return report;
}

const writeResult = (affected: number) => ({
  affected,
  raw: [],
  generatedMaps: [],
});

describe('AdminService', () => {
  let noticeFind: jest.MockedFunction<Repository<NoticeToMariners>['find']>;
  let noticeUpdate: jest.MockedFunction<Repository<NoticeToMariners>['update']>;
  let noticeSave: jest.MockedFunction<Repository<NoticeToMariners>['save']>;
  let noticeCreate: jest.MockedFunction<Repository<NoticeToMariners>['create']>;
  let noticeDelete: jest.MockedFunction<Repository<NoticeToMariners>['delete']>;
  let reportFind: jest.MockedFunction<Repository<UserReport>['find']>;
  let reportUpdate: jest.MockedFunction<Repository<UserReport>['update']>;
  let reportDelete: jest.MockedFunction<Repository<UserReport>['delete']>;
  let logsFind: jest.MockedFunction<Repository<Logs>['find']>;
  let logsCreate: jest.MockedFunction<Repository<Logs>['create']>;
  let logsSave: jest.MockedFunction<Repository<Logs>['save']>;
  let getNotices: jest.MockedFunction<MapService['getNotices']>;
  let service: AdminService;

  beforeEach(() => {
    noticeFind = jest.fn();
    noticeUpdate = jest.fn();
    noticeSave = jest.fn((n: NoticeToMariners) => Promise.resolve(n)) as never;
    noticeCreate = jest.fn((n: Partial<NoticeToMariners>) => n) as never;
    noticeDelete = jest.fn();
    reportFind = jest.fn();
    reportUpdate = jest.fn();
    reportDelete = jest.fn();
    logsFind = jest.fn();
    logsCreate = jest.fn((l: Partial<Logs>) => l) as never;
    logsSave = jest.fn();
    getNotices = jest.fn();

    const noticeRepo = {
      find: noticeFind,
      update: noticeUpdate,
      save: noticeSave,
      create: noticeCreate,
      delete: noticeDelete,
    } as unknown as Repository<NoticeToMariners>;
    const reportRepo = {
      find: reportFind,
      update: reportUpdate,
      delete: reportDelete,
    } as unknown as Repository<UserReport>;
    const logsRepo = {
      find: logsFind,
      create: logsCreate,
      save: logsSave,
    } as unknown as Repository<Logs>;
    const mapService = { getNotices } as unknown as MapService;

    service = new AdminService(noticeRepo, reportRepo, logsRepo, mapService);
  });

  describe('viewLogs', () => {
    it('filters by logType and since, paginates, and flags hasMore', async () => {
      const since = new Date('2026-05-01T00:00:00.000Z');
      logsFind.mockResolvedValue([{} as Logs, {} as Logs]);

      const result = await service.viewLogs({
        logType: LogType.IMPORT_JOB,
        since,
        limit: 1,
        offset: 0,
      });

      expect(result).toEqual({
        items: [{}],
        limit: 1,
        offset: 0,
        hasMore: true,
      });
      const options = logsFind.mock.calls[0]?.[0];
      expect(options).toEqual(
        expect.objectContaining({
          order: { createdAt: 'DESC' },
          take: 2,
          skip: 0,
        }),
      );
      expect(options?.where).toEqual(
        expect.objectContaining({ logType: LogType.IMPORT_JOB }),
      );
      expect(options?.where).toHaveProperty('createdAt');
    });

    it('omits filters when logType and since are absent', async () => {
      logsFind.mockResolvedValue([]);

      await service.viewLogs({ limit: 100, offset: 0 });

      expect(logsFind.mock.calls[0]?.[0]?.where).toEqual({});
    });
  });

  describe('viewFlaggedNotices', () => {
    it('queries reports >= minReports ordered by reports desc and serializes', async () => {
      noticeFind.mockResolvedValue([makeNotice({ reports: 5 })]);

      const result = await service.viewFlaggedNotices({
        minReports: 3,
        limit: 50,
        offset: 0,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({ title: 'Temporary works', reports: 5 }),
      );
      expect(result.hasMore).toBe(false);
      const options = noticeFind.mock.calls[0]?.[0];
      expect(options).toEqual(
        expect.objectContaining({
          order: { reports: 'DESC', createdAt: 'DESC' },
          take: 51,
          skip: 0,
        }),
      );
      expect(options?.where).toHaveProperty('reports');
    });
  });

  describe('viewNoticesInReview', () => {
    it('delegates to MapService with the review flag set', async () => {
      const query = { activeOnly: true, limit: 10, offset: 0 };
      getNotices.mockResolvedValue({
        items: [],
        limit: 10,
        offset: 0,
        hasMore: false,
      });

      await service.viewNoticesInReview(query);

      expect(getNotices).toHaveBeenCalledWith(query, true);
    });
  });

  describe('viewReports', () => {
    it('queries user reports by resolved state, newest first, and paginates', async () => {
      reportFind.mockResolvedValue([
        makeReport({ id: 'report-1' }),
        makeReport({ id: 'report-2' }),
      ]);

      const result = await service.viewReports({
        resolved: false,
        limit: 1,
        offset: 10,
      });

      expect(result.items).toHaveLength(1);
      expect(result.hasMore).toBe(true);
      const options = reportFind.mock.calls[0]?.[0];
      expect(options).toEqual(
        expect.objectContaining({
          where: { resolved: false },
          order: { createdAt: 'DESC' },
          take: 2,
          skip: 10,
        }),
      );
    });
  });

  describe('resolveReport', () => {
    it('marks a user report as resolved', async () => {
      reportUpdate.mockResolvedValue(writeResult(1));

      await service.resolveReport('report-1');

      expect(reportUpdate).toHaveBeenCalledWith('report-1', {
        resolved: true,
      });
    });

    it('throws NotFound for an unknown report id', async () => {
      reportUpdate.mockResolvedValue(writeResult(0));

      await expect(service.resolveReport('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteReport', () => {
    it('deletes a user report by id', async () => {
      reportDelete.mockResolvedValue({ affected: 1, raw: [] });

      await service.deleteReport('report-1');

      expect(reportDelete).toHaveBeenCalledWith('report-1');
    });

    it('throws NotFound when no user report is deleted', async () => {
      reportDelete.mockResolvedValue({ affected: 0, raw: [] });

      await expect(service.deleteReport('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('approveNtM', () => {
    it('clears needsReview and reasons without touching reports', async () => {
      const notice = makeNotice();
      noticeUpdate.mockResolvedValue(writeResult(1));

      await service.approveNtM(notice.id);

      expect(noticeUpdate).toHaveBeenCalledWith(notice.id, {
        needsReview: false,
        reviewReasons: [],
      });
    });

    it('throws NotFound for an unknown id', async () => {
      noticeUpdate.mockResolvedValue(writeResult(0));

      await expect(service.approveNtM('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('dismissReports', () => {
    it('resets reports without touching needsReview', async () => {
      const notice = makeNotice();
      noticeUpdate.mockResolvedValue(writeResult(1));

      await service.dismissReports(notice.id);

      expect(noticeUpdate).toHaveBeenCalledWith(notice.id, { reports: 0 });
    });

    it('throws NotFound for an unknown id', async () => {
      noticeUpdate.mockResolvedValue(writeResult(0));

      await expect(service.dismissReports('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('rejectNtM', () => {
    it('deletes the notice by id', async () => {
      const id = '0f1e8f1e-9b91-4f59-bb4f-a82d06e4f950';
      noticeDelete.mockResolvedValue({ affected: 1, raw: [] });

      await service.rejectNtM(id);

      expect(noticeDelete).toHaveBeenCalledWith(id);
    });

    it('throws NotFound when no row is deleted', async () => {
      noticeDelete.mockResolvedValue({ affected: 0, raw: [] });

      await expect(
        service.rejectNtM('0f1e8f1e-9b91-4f59-bb4f-a82d06e4f950'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('addNtm', () => {
    it('persists the notice as not-in-review and writes a manual-add log', async () => {
      const dto = {
        kind: NoticeKind.INFO,
        title: 'Manual notice',
        description: 'Entered by admin.',
        source: 'manual:admin',
        publishedAt: new Date('2026-05-01T00:00:00.000Z'),
        activeFrom: new Date('2026-05-02T00:00:00.000Z'),
      } as CreateNoticeDto;
      noticeSave.mockImplementation((n) =>
        Promise.resolve(makeNotice({ ...(n as object), id: 'new-id' })),
      );

      const saved = await service.addNtm(dto);

      expect(noticeCreate).toHaveBeenCalledWith(
        expect.objectContaining({ ...dto, needsReview: false }),
      );
      expect(saved.id).toBe('new-id');
      expect(logsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ logType: LogType.NEW_NTM_MANUAL }),
      );
      expect(logsSave).toHaveBeenCalled();
    });
  });
});
