import type { Repository } from 'typeorm';
import {
  DatasetCatalogService,
  type DatasetEntry,
} from './dataset-catalog.service';
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
  let list: jest.MockedFunction<DatasetCatalogService['list']>;
  let requireEntry: jest.MockedFunction<DatasetCatalogService['requireEntry']>;
  let service: MapService;

  beforeEach(() => {
    find = jest.fn<Repository<NoticeToMariners>['find']>();
    list = jest.fn<DatasetCatalogService['list']>();
    requireEntry = jest.fn<DatasetCatalogService['requireEntry']>();

    service = new MapService(
      { find } as unknown as Repository<NoticeToMariners>,
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

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(
      expect.objectContaining({
        kind: NoticeKind.AREA,
        title: 'Temporary works',
        geometry: { type: 'Point', coordinates: [14.5, 35.9] },
      }),
    );
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { activeFrom: 'DESC' },
        take: 25,
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
        take: 10,
        skip: 0,
      }),
    );
  });

  it('delegates dataset reads to the catalog service', () => {
    const entry: DatasetEntry = {
      filePath: '/tmp/example.geojson',
      metadata: {
        key: 'example',
        name: 'Example',
        sourceUrl: 'https://example.com/data.geojson',
        featureCount: 1,
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
