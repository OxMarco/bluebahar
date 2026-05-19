import type OpenAI from 'openai';
import { NoticeKind } from '../../notice-kind';
import { callOutline, type OutlineRecord } from './outline';

function record(overrides: Partial<OutlineRecord> = {}): OutlineRecord {
  return {
    subKey: 'Bunkering Area 1',
    kind: NoticeKind.AREA,
    title: 'Bunkering Area 1',
    description: 'Temporary restrictions in Bunkering Area 1.',
    locationLabel: null,
    publishedAt: '2026-01-01',
    activeFrom: '2026-01-02',
    activeTo: null,
    distance: null,
    depth: null,
    geometryParts: [],
    headingAnchor: 'Bunkering Area 1',
    pageStart: 1,
    pageEnd: 1,
    ...overrides,
  };
}

function mockOpenAI(parsed: { notices: OutlineRecord[] } | null) {
  const parse = jest.fn().mockResolvedValue({
    choices: [{ message: { parsed } }],
  });

  return {
    openai: {
      chat: {
        completions: {
          parse,
        },
      },
    } as unknown as OpenAI,
    parse,
  };
}

describe('callOutline', () => {
  it('returns notices from the parsed structured output', async () => {
    const notices = [
      record({ subKey: 'Bunkering Area 1', headingAnchor: 'Bunkering Area 1' }),
      record({ subKey: 'Bunkering Area 2', headingAnchor: 'Bunkering Area 2' }),
    ];
    const { openai, parse } = mockOpenAI({ notices });

    await expect(
      callOutline('https://example.com/ntm.pdf', openai, 'pdf text'),
    ).resolves.toEqual(notices);
    const responseFormatMatcher: unknown = expect.any(Object);
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.5',
        response_format: responseFormatMatcher,
      }),
    );
  });

  it('coerces single-record subKey and headingAnchor to empty strings', async () => {
    const { openai } = mockOpenAI({
      notices: [
        record({
          subKey: 'Verbose section title',
          headingAnchor: 'Verbose section title',
        }),
      ],
    });

    await expect(
      callOutline('https://example.com/ntm.pdf', openai, 'pdf text'),
    ).resolves.toEqual([
      expect.objectContaining({ subKey: '', headingAnchor: '' }),
    ]);
  });

  it('rejects duplicate subKeys within one PDF', async () => {
    const { openai } = mockOpenAI({
      notices: [
        record({ subKey: 'Grand Harbour', headingAnchor: 'Grand Harbour' }),
        record({ subKey: 'Grand Harbour', headingAnchor: 'Grand Harbour' }),
      ],
    });

    await expect(
      callOutline('https://example.com/ntm.pdf', openai, 'pdf text'),
    ).rejects.toThrow("LLM returned duplicate subKey 'Grand Harbour'");
  });

  it('rejects an empty subKey alongside other records', async () => {
    const { openai } = mockOpenAI({
      notices: [
        record({ subKey: '', headingAnchor: '' }),
        record({ subKey: 'Marsaxlokk', headingAnchor: 'Marsaxlokk' }),
      ],
    });

    await expect(
      callOutline('https://example.com/ntm.pdf', openai, 'pdf text'),
    ).rejects.toThrow('LLM returned an empty subKey alongside other records');
  });
});
