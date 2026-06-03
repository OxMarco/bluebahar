import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import * as core from './core';
import { extractNoticeFromBuffer } from './extract';
import { runRegex } from './regex-strategy';
import { buildFeatureCollection } from './geometry';
import { adaptToParsedNotice } from './adapter';

// PDF text is captured from the real Transport Malta notices (see __fixtures__).
// We drive the substantive pipeline (regex -> GeoJSON -> ParsedNotice) directly
// off that text rather than parsing the PDF in-process: pdf-parse pulls in
// pdfjs's worker, which jest's CommonJS VM can't dynamically import. PDF parsing
// itself is exercised at runtime, not here.
const FIXTURES = join(__dirname, '__fixtures__');
function fixture(name: string): { text: string; pages: number } {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.txt`), 'utf8')) as {
    text: string;
    pages: number;
  };
}

function pipeline(name: string) {
  const { text, pages } = fixture(name);
  const { extraction, meta } = runRegex(text, pages, `${name}.pdf`);
  const featureCollection = buildFeatureCollection(extraction);
  return adaptToParsedNotice({
    source: `file://${name}.pdf`,
    extraction,
    featureCollection,
    enrichment: null,
    notes: meta.notes,
  });
}

describe('regex -> geometry -> adapter (real notice text)', () => {
  it('extracts coastline-closed restriction polygons from an area notice', () => {
    const notice = pipeline('Not_29_of_2025');
    expect(notice.kind).toBe('area');
    expect(notice.title.length).toBeGreaterThan(0);

    const polygons = notice.areas.filter((a) => a.geometryType === 'polygon');
    expect(polygons.length).toBeGreaterThan(0);
    for (const part of notice.areas) {
      for (const p of part.points) {
        expect(Number.isFinite(p.lat)).toBe(true);
        expect(Number.isFinite(p.long)).toBe(true);
      }
    }
    const first = polygons[0].points[0];
    expect(first.lat).toBeGreaterThan(35.6);
    expect(first.lat).toBeLessThan(36.25);
    expect(first.long).toBeGreaterThan(14.0);
    expect(first.long).toBeLessThan(14.8);
  });

  it('realises a firing-practice sector as a polygon', () => {
    const notice = pipeline('Not_35_of_2026');
    expect(notice.kind).toBe('area');
    expect(
      notice.areas.some(
        (a) => a.geometryType === 'polygon' && a.points.length > 3,
      ),
    ).toBe(true);
  });

  it('classifies a coordinate-less cumulative notice as advisory', () => {
    const notice = pipeline('Not_097_of_2025');
    expect(notice.areas).toHaveLength(0);
    expect(notice.kind).toBe('advisory');
    expect(notice.needsReview).toBe(false);
    expect(notice.description.length).toBeGreaterThan(0);
  });
});

describe('extractNoticeFromBuffer orchestration', () => {
  afterEach(() => jest.restoreAllMocks());

  function fakeOpenAI(create: jest.Mock): OpenAI {
    return { responses: { create } } as unknown as OpenAI;
  }

  it('uses the AI enrichment description when enrichment succeeds', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    const create = jest.fn().mockResolvedValue({
      output_text: JSON.stringify({
        category: 'alert',
        summary: 'Live firing practice at Pembroke Ranges.',
        recommended_action: 'Keep 4 NM off the coast.',
        affected_locations: ['Pembroke Ranges'],
        validity: '8 June 2026',
      }),
      usage: { input_tokens: 100, output_tokens: 20 },
    });

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(create),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe(
      'Live firing practice at Pembroke Ranges.\n\nKeep 4 NM off the coast.',
    );
    expect(out[0].locationLabel).toBe('Pembroke Ranges');
    // Geometry is still deterministic regardless of the AI step.
    expect(out[0].areas.length).toBeGreaterThan(0);
  });

  it('keeps deterministic geometry and a rule-based description when enrichment fails', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    const create = jest.fn().mockRejectedValue(new Error('rate limited'));

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(create),
    );

    expect(out[0].areas.length).toBeGreaterThan(0);
    expect(out[0].description).toContain('New restriction.');
  });

  it('skips the AI call entirely when enrich is disabled', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_097_of_2025'));
    const create = jest.fn();

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_097_of_2025.pdf',
      fakeOpenAI(create),
      { enrich: false },
    );

    expect(create).not.toHaveBeenCalled();
    expect(out[0].kind).toBe('advisory');
  });
});
