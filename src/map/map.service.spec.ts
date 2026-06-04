import type { Repository } from 'typeorm';
import {
  DatasetCatalogService,
  type DatasetEntry,
} from './dataset-catalog.service';
import { NotFoundException } from '@nestjs/common';
import { MapService } from './map.service';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { NoticeKind } from '../scraper/notice-kind';
import type { GetNoticesDto } from './dto/get-notices.dto';

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
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
  });
  return notice;
}

describe('MapService', () => {
  let find: jest.MockedFunction<Repository<NoticeToMariners>['find']>;
  let count: jest.MockedFunction<Repository<NoticeToMariners>['count']>;
  let increment: jest.MockedFunction<Repository<NoticeToMariners>['increment']>;
  let list: jest.MockedFunction<DatasetCatalogService['list']>;
  let requireEntry: jest.MockedFunction<DatasetCatalogService['requireEntry']>;
  let service: MapService;

  beforeEach(() => {
    find = jest.fn() as jest.MockedFunction<
      Repository<NoticeToMariners>['find']
    >;
    count = jest.fn() as jest.MockedFunction<
      Repository<NoticeToMariners>['count']
    >;
    increment = jest.fn() as jest.MockedFunction<
      Repository<NoticeToMariners>['increment']
    >;
    list = jest.fn() as jest.MockedFunction<DatasetCatalogService['list']>;
    requireEntry = jest.fn() as jest.MockedFunction<
      DatasetCatalogService['requireEntry']
    >;

    service = new MapService(
      { find, count, increment } as unknown as Repository<NoticeToMariners>,
      { list, requireEntry } as unknown as DatasetCatalogService,
    );
  });

  it('queries active public notices with pagination and serializes results', async () => {
    find.mockResolvedValue([makeNotice()]);

    const query: GetNoticesDto = {
      activeOnly: true,
      kind: NoticeKind.AREA,
      limit: 25,
      offset: 50,
    };

    const result = await service.getNotices(query);

    expect(result).toEqual(
      expect.objectContaining({
        limit: 25,
        offset: 50,
        hasMore: false,
      }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        kind: NoticeKind.AREA,
        title: 'Temporary works',
        geometry: { type: 'Point', coordinates: [14.5, 35.9] },
      }),
    );
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { activeFrom: 'DESC' },
        take: 26,
        skip: 50,
      }),
    );

    const options = find.mock.calls[0]?.[0];
    const where = options?.where;
    expect(Array.isArray(where)).toBe(true);
    if (!Array.isArray(where))
      throw new Error('Expected active query branches');
    expect(where).toHaveLength(2);
    expect(where[0]).toEqual(
      expect.objectContaining({
        needsReview: false,
        kind: NoticeKind.AREA,
      }),
    );
    expect(where[0]).toHaveProperty('activeFrom');
    expect(where[0]).toHaveProperty('activeTo');
    expect(where[1]).toEqual(
      expect.objectContaining({
        needsReview: false,
        kind: NoticeKind.AREA,
      }),
    );
  });

  it('can query review notices without active-date filtering', async () => {
    find.mockResolvedValue([]);

    const query: GetNoticesDto = {
      activeOnly: false,
      limit: 10,
      offset: 0,
    };

    await service.getNotices(query, true);

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { needsReview: true },
        take: 11,
        skip: 0,
      }),
    );
  });

  it('uses one extra row to flag whether another page exists', async () => {
    find.mockResolvedValue([makeNotice({ id: 'a' }), makeNotice({ id: 'b' })]);

    const result = await service.getNotices({
      activeOnly: false,
      limit: 1,
      offset: 0,
    });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it('returns notice review and visibility metrics', async () => {
    count
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(9)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    const result = await service.getNoticeMetrics();

    expect(result).toEqual(
      expect.objectContaining({
        total: 12,
        publicCount: 9,
        needsReviewCount: 3,
        activePublicCount: 4,
        activeNeedsReviewCount: 2,
      }),
    );
    expect(result.byKind).toEqual([
      { kind: NoticeKind.AREA, total: 6, publicCount: 5, needsReviewCount: 1 },
      {
        kind: NoticeKind.ADVISORY,
        total: 2,
        publicCount: 1,
        needsReviewCount: 1,
      },
    ]);
    expect(count).toHaveBeenCalledTimes(11);
  });

  it('atomically increments the report counter', async () => {
    increment.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

    await service.report('notice-1');

    expect(increment).toHaveBeenCalledWith({ id: 'notice-1' }, 'reports', 1);
  });

  it('throws NotFound when reporting an unknown notice', async () => {
    increment.mockResolvedValue({ affected: 0, raw: [], generatedMaps: [] });

    await expect(service.report('missing')).rejects.toThrow(NotFoundException);
  });

  it('delegates dataset reads to the catalog service', () => {
    const entry: DatasetEntry = {
      payload: '{"type":"FeatureCollection","features":[]}',
      metadata: {
        key: 'example',
        name: 'Example',
        kind: 'context',
        sourceUrl: 'https://example.com/data.geojson',
        featureCount: 1,
        geometryTypes: ['Point'],
        bbox: [14.5, 35.9, 14.5, 35.9],
        byteSize: 2,
        sha256: 'abc123',
      },
    };
    list.mockReturnValue([entry.metadata]);
    requireEntry.mockReturnValue(entry);

    expect(service.listDatasets()).toEqual([entry.metadata]);
    expect(service.requireDataset('example')).toBe(entry);
    expect(requireEntry).toHaveBeenCalledWith('example');
  });
});
