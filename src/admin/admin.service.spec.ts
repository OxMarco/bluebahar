import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { AdminService } from './admin.service';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Logs } from '../scraper/entities/logs.entity';
import { LogType } from '../scraper/log-type';
import { NoticeKind } from '../scraper/notice-kind';
import { MapService } from '../map/map.service';
import type { CreateNoticeDto } from './dto/create-notice.dto';

function makeNotice(
  overrides: Partial<NoticeToMariners> = {},
): NoticeToMariners {
  const notice = new NoticeToMariners();
  Object.assign(notice, {
    id: '0f1e8f1e-9b91-4f59-bb4f-a82d06e4f950',
    kind: NoticeKind.AREA,
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

describe('AdminService', () => {
  let noticeFind: jest.MockedFunction<Repository<NoticeToMariners>['find']>;
  let noticeFindOneBy: jest.MockedFunction<
    Repository<NoticeToMariners>['findOneBy']
  >;
  let noticeSave: jest.MockedFunction<Repository<NoticeToMariners>['save']>;
  let noticeCreate: jest.MockedFunction<Repository<NoticeToMariners>['create']>;
  let noticeDelete: jest.MockedFunction<Repository<NoticeToMariners>['delete']>;
  let logsFind: jest.MockedFunction<Repository<Logs>['find']>;
  let logsCreate: jest.MockedFunction<Repository<Logs>['create']>;
  let logsSave: jest.MockedFunction<Repository<Logs>['save']>;
  let getNotices: jest.MockedFunction<MapService['getNotices']>;
  let service: AdminService;

  beforeEach(() => {
    noticeFind = jest.fn();
    noticeFindOneBy = jest.fn();
    noticeSave = jest.fn((n: NoticeToMariners) => Promise.resolve(n)) as never;
    noticeCreate = jest.fn((n: Partial<NoticeToMariners>) => n) as never;
    noticeDelete = jest.fn();
    logsFind = jest.fn();
    logsCreate = jest.fn((l: Partial<Logs>) => l) as never;
    logsSave = jest.fn();
    getNotices = jest.fn();

    const noticeRepo = {
      find: noticeFind,
      findOneBy: noticeFindOneBy,
      save: noticeSave,
      create: noticeCreate,
      delete: noticeDelete,
    } as unknown as Repository<NoticeToMariners>;
    const logsRepo = {
      find: logsFind,
      create: logsCreate,
      save: logsSave,
    } as unknown as Repository<Logs>;
    const mapService = { getNotices } as unknown as MapService;

    service = new AdminService(noticeRepo, logsRepo, mapService);
  });

  describe('viewLogs', () => {
    it('filters by logType and since, paginates, and flags hasMore', async () => {
      const since = new Date('2026-05-01T00:00:00.000Z');
      logsFind.mockResolvedValue([{} as Logs, {} as Logs]);

      const result = await service.viewLogs({
        logType: LogType.SCRAPING_JOB,
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
        expect.objectContaining({ logType: LogType.SCRAPING_JOB }),
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
        expect.objectContaining({ title: 'Temporary works' }),
      );
      expect(result.hasMore).toBe(false);
      const options = noticeFind.mock.calls[0]?.[0];
      expect(options).toEqual(
        expect.objectContaining({
          order: { reports: 'DESC' },
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

  describe('approveNtM', () => {
    it('clears needsReview without touching reports', async () => {
      const notice = makeNotice({ needsReview: true, reports: 4 });
      noticeFindOneBy.mockResolvedValue(notice);

      await service.approveNtM(notice.id);

      expect(notice.needsReview).toBe(false);
      expect(notice.reports).toBe(4);
      expect(noticeSave).toHaveBeenCalledWith(notice);
    });

    it('throws NotFound for an unknown id', async () => {
      noticeFindOneBy.mockResolvedValue(null);

      await expect(service.approveNtM('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('dismissReports', () => {
    it('resets reports without touching needsReview', async () => {
      const notice = makeNotice({ needsReview: true, reports: 9 });
      noticeFindOneBy.mockResolvedValue(notice);

      await service.dismissReports(notice.id);

      expect(notice.reports).toBe(0);
      expect(notice.needsReview).toBe(true);
      expect(noticeSave).toHaveBeenCalledWith(notice);
    });

    it('throws NotFound for an unknown id', async () => {
      noticeFindOneBy.mockResolvedValue(null);

      await expect(service.dismissReports('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('rejectNtM', () => {
    it('deletes the notice by id', async () => {
      await service.rejectNtM('notice-1');

      expect(noticeDelete).toHaveBeenCalledWith('notice-1');
    });
  });

  describe('addNtm', () => {
    it('persists the notice as not-in-review and writes a manual-add log', async () => {
      const dto = {
        kind: NoticeKind.ADVISORY,
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
