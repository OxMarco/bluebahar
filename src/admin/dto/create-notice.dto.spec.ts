import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { CreateNoticeDto } from './create-notice.dto';
import { NoticeKind } from '../../map/notice-kind';

function messagesOf(errors: ValidationError[]): string[] {
  const walk = (e: ValidationError): string[] => [
    ...Object.values(e.constraints ?? {}),
    ...(e.children ?? []).flatMap(walk),
  ];
  return errors.flatMap(walk);
}

function validate(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateNoticeDto, body);
  const errors = validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, messages: messagesOf(errors) };
}

const base = {
  kind: NoticeKind.ALERT,
  title: 'Temporary works',
  description: 'Works in progress.',
  source: 'https://example.com/notice.pdf',
  publishedAt: '2026-01-01T00:00',
  activeFrom: '2026-01-02T00:00',
};

const areas = (parts: unknown) => ({ ...base, areas: JSON.stringify(parts) });

describe('CreateNoticeDto areas', () => {
  it('parses the JSON hidden field into nested point/line/polygon parts', () => {
    const { dto, messages } = validate(
      areas([
        {
          label: 'Wreck',
          geometryType: 'point',
          points: [{ lat: 35.9, long: 14.5 }],
        },
        {
          label: 'Channel',
          geometryType: 'line',
          points: [
            { lat: 35.9, long: 14.5 },
            { lat: 35.91, long: 14.52 },
          ],
        },
        {
          label: 'Zone',
          geometryType: 'polygon',
          points: [
            { lat: 35.9, long: 14.5 },
            { lat: 35.91, long: 14.52 },
            { lat: 35.92, long: 14.5 },
          ],
        },
      ]),
    );

    expect(messages).toEqual([]);
    expect(dto.areas).toHaveLength(3);
    expect(dto.areas?.map((a) => a.geometryType)).toEqual([
      'point',
      'line',
      'polygon',
    ]);
    expect(dto.areas?.[2].points).toHaveLength(3);
  });

  it('rejects a polygon with fewer than three points', () => {
    const { messages } = validate(
      areas([
        {
          label: 'Zone',
          geometryType: 'polygon',
          points: [
            { lat: 35.9, long: 14.5 },
            { lat: 35.91, long: 14.52 },
          ],
        },
      ]),
    );

    expect(messages).toContain('A polygon geometry needs at least 3 points.');
  });

  it('rejects a line with fewer than two points', () => {
    const { messages } = validate(
      areas([
        {
          label: 'L',
          geometryType: 'line',
          points: [{ lat: 35.9, long: 14.5 }],
        },
      ]),
    );

    expect(messages).toContain('A line geometry needs at least 2 points.');
  });

  it('rejects coordinates outside valid lat/long ranges', () => {
    const { messages } = validate(
      areas([
        {
          label: '',
          geometryType: 'point',
          points: [{ lat: 999, long: 14.5 }],
        },
      ]),
    );

    expect(messages).toContain('lat must not be greater than 90');
  });

  it('strips unknown fields inside a geometry part', () => {
    const { messages } = validate(
      areas([
        {
          label: 'x',
          geometryType: 'point',
          points: [{ lat: 36, long: 14.6 }],
          injected: true,
        },
      ]),
    );

    expect(messages).toContain('property injected should not exist');
  });

  it('treats an empty hidden field as no geometry', () => {
    const { dto, messages } = validate({ ...base, areas: '' });

    expect(messages).toEqual([]);
    expect(dto.areas).toBeUndefined();
  });

  it('reports an array error when the field is not valid JSON', () => {
    const { messages } = validate({ ...base, areas: 'not-json' });

    expect(messages).toContain('areas must be an array');
  });
});
