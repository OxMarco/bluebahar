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
  return pipelineText(text, pages, `${name}.pdf`, `file://${name}.pdf`);
}

function pipelineText(
  text: string,
  pages = 1,
  sourceFile = 'synthetic.pdf',
  source = `file://${sourceFile}`,
) {
  const { extraction, meta } = runRegex(text, pages, sourceFile);
  const featureCollection = buildFeatureCollection(extraction);
  return adaptToParsedNotice({
    source,
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
    expect(notice.activeFrom.toISOString()).toBe('2026-06-08T14:30:00.000Z');
    expect(notice.activeTo?.toISOString()).toBe('2026-06-08T16:00:00.000Z');
    expect(notice.needsReview).toBe(false);
  });

  it('classifies a coordinate-less cumulative notice as advisory', () => {
    const notice = pipeline('Not_097_of_2025');
    expect(notice.areas).toHaveLength(0);
    expect(notice.kind).toBe('advisory');
    expect(notice.needsReview).toBe(false);
    expect(notice.description.length).toBeGreaterThan(0);
  });

  it('flags catch-all generic geometry for manual review', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 77 of 2026
3 June 2026
Temporary restricted area
Mariners are notified that a restricted area is established.
Position Latitude (N) Longitude (E)
A 35° 55'.540 014° 28'.320
B 35° 59'.460 014° 27'.150
C 35° 58'.290 014° 32'.190
`);

    expect(notice.kind).toBe('area');
    expect(notice.needsReview).toBe(true);
    expect(notice.reviewReasons).toContain(
      'generic_extraction_verify_geometry',
    );
  });

  it('flags coordinates dropped by generic scanning as outside Malta bounds', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 78 of 2026
3 June 2026
Temporary restricted area
Mariners are notified that a restricted area is established.
Position Latitude (N) Longitude (E)
A 35° 55'.540 014° 28'.320
B 35° 59'.460 015° 27'.150
C 35° 58'.290 014° 32'.190
D 35° 57'.290 014° 31'.190
`);

    expect(notice.needsReview).toBe(true);
    expect(
      notice.reviewReasons.some((r) =>
        r.startsWith('generic_coord_outside_malta_bbox:'),
      ),
    ).toBe(true);
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

  it('skips enrichment and yields no records for an already-expired notice', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    const create = jest.fn();

    // Not_35_of_2026 is valid through 2026-06-08; reference a later "now".
    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(create),
      { now: new Date('2026-06-09T00:00:00.000Z') },
    );

    expect(out).toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it('still parses a notice whose validity window has not yet lapsed', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    const create = jest.fn().mockRejectedValue(new Error('offline'));

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(create),
      { now: new Date('2026-06-08T15:00:00.000Z') },
    );

    expect(out).toHaveLength(1);
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
