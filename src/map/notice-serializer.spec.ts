import { NoticeKind } from '../scraper/notice-kind';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { toNoticeDto } from './notice-serializer';

type NoticeArea = NoticeToMariners['areas'][number];

function makeNotice(
  areas: NoticeArea[],
  overrides: Partial<NoticeToMariners> = {},
): NoticeToMariners {
  const notice = new NoticeToMariners();
  Object.assign(notice, {
    id: '0f1e8f1e-9b91-4f59-bb4f-a82d06e4f950',
    kind: NoticeKind.AREA,
    title: 'Test notice',
    description: 'A notice used by tests.',
    source: 'https://example.com/notice.pdf',
    subKey: '',
    areas,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    activeFrom: new Date('2026-01-02T00:00:00.000Z'),
    needsReview: false,
    createdAt: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
  });
  return notice;
}

describe('toNoticeDto', () => {
  it('serializes point notices in GeoJSON coordinate order', () => {
    const dto = toNoticeDto(
      makeNotice(
        [
          {
            label: 'Wreck',
            geometryType: 'point',
            points: [{ lat: 35.9, long: 14.5 }],
          },
        ],
        {
          kind: NoticeKind.FACILITY,
          locationLabel: 'Kalkara Harbour',
          activeTo: new Date('2026-01-04T00:00:00.000Z'),
          distance: 300,
        },
      ),
    );

    expect(dto).toEqual(
      expect.objectContaining({
        locationLabel: 'Kalkara Harbour',
        activeFrom: '2026-01-02T00:00:00.000Z',
        activeTo: '2026-01-04T00:00:00.000Z',
        distance: 300,
        geometry: { type: 'Point', coordinates: [14.5, 35.9] },
      }),
    );
  });

  it('auto-closes valid polygon rings', () => {
    const dto = toNoticeDto(
      makeNotice([
        {
          label: 'Swimming zone',
          geometryType: 'polygon',
          points: [
            { lat: 35.9, long: 14.5 },
            { lat: 35.91, long: 14.51 },
            { lat: 35.9, long: 14.52 },
          ],
        },
      ]),
    );

    expect(dto.geometry).toEqual({
      type: 'Polygon',
      coordinates: [
        [
          [14.5, 35.9],
          [14.51, 35.91],
          [14.52, 35.9],
          [14.5, 35.9],
        ],
      ],
    });
  });

  it('returns a geometry collection when a notice has multiple drawable parts', () => {
    const dto = toNoticeDto(
      makeNotice([
        {
          label: 'Cable',
          geometryType: 'line',
          points: [
            { lat: 35.9, long: 14.5 },
            { lat: 35.91, long: 14.51 },
          ],
        },
        {
          label: 'Marker',
          geometryType: 'point',
          points: [{ lat: 35.92, long: 14.52 }],
        },
      ]),
    );

    expect(dto.geometry).toEqual({
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [14.5, 35.9],
            [14.51, 35.91],
          ],
        },
        { type: 'Point', coordinates: [14.52, 35.92] },
      ],
    });
  });

  it('returns null geometry when no part can produce valid GeoJSON', () => {
    const dto = toNoticeDto(
      makeNotice([
        {
          label: 'Incomplete line',
          geometryType: 'line',
          points: [{ lat: 35.9, long: 14.5 }],
        },
      ]),
    );

    expect(dto.geometry).toBeNull();
    expect(dto.activeTo).toBeNull();
    expect(dto.distance).toBeNull();
  });
});
