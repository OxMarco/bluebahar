import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import * as core from './core';
import { extractNoticeFromBuffer } from './extract';
import { runRegex } from './regex-strategy';
import { buildFeatureCollection } from './geometry';
import { adaptToParsedNotice } from './adapter';
import type { Area, NoticeExtraction } from './types';

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

function areaNotice(area: Area) {
  const extraction: NoticeExtraction = {
    source_file: 'synthetic.pdf',
    notice_no: '99',
    notice_year: '2026',
    date: '2026-06-03',
    title: 'Synthetic restriction',
    document_type: 'new_restriction',
    valid_from: '2026-06-03',
    valid_to: null,
    referenced_notices: [],
    charts_affected: [],
    areas: [area],
  };
  return adaptToParsedNotice({
    source: 'file://synthetic.pdf',
    extraction,
    featureCollection: buildFeatureCollection(extraction),
    enrichment: null,
    notes: [`coords:${area.points.length}`],
  });
}

function polygonArea(
  areaId: string,
  points: Array<{ lat: number; lon: number }>,
): Area {
  return {
    area_id: areaId,
    name: 'Synthetic area',
    chart: null,
    zone_color: null,
    hazard_type: 'restricted_area',
    operation: 'new',
    geometry_kind: 'polygon',
    point_labels: points.map((_, i) => `P${i + 1}`),
    points: points.map((p, i) => ({ label: `P${i + 1}`, ...p })),
    radius_nm: null,
    buffer_m: null,
    restrictions: [],
  };
}

describe('regex -> geometry -> adapter (real notice text)', () => {
  it('extracts coastline-closed restriction polygons from an area notice', () => {
    const notice = pipeline('Not_29_of_2025');
    expect(notice.kind).toBe('alert');
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
    expect(notice.needsReview).toBe(false);
  });

  it('realises a firing-practice sector as a polygon', () => {
    const notice = pipeline('Not_35_of_2026');
    expect(notice.kind).toBe('alert');
    expect(
      notice.areas.some(
        (a) => a.geometryType === 'polygon' && a.points.length > 3,
      ),
    ).toBe(true);
    expect(notice.activeFrom.toISOString()).toBe('2026-06-08T14:30:00.000Z');
    expect(notice.activeTo?.toISOString()).toBe('2026-06-08T16:00:00.000Z');
    expect(notice.needsReview).toBe(false);
  });

  it('keeps kind independent of geometry: a coordinate-less restriction is still an alert', () => {
    // A waste-disposal reminder with no coordinates. It quotes "prohibited", so
    // the deterministic classifier (used when AI enrichment is off) calls it a
    // restriction and conservatively returns 'alert' — proving kind comes from
    // the notice's meaning, not from whether it has plottable areas. In
    // production the AI enrichment would refine an administrative reminder to
    // 'info'.
    const notice = pipeline('Not_097_of_2025');
    expect(notice.areas).toHaveLength(0);
    expect(notice.kind).toBe('alert');
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

    expect(notice.kind).toBe('alert');
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

  it('flags an area realised entirely on land for manual review', () => {
    const notice = areaNotice(
      polygonArea('land-area', [
        { lat: 35.89, lon: 14.42 },
        { lat: 35.89, lon: 14.43 },
        { lat: 35.9, lon: 14.43 },
      ]),
    );

    expect(notice.needsReview).toBe(true);
    expect(notice.reviewReasons).toContain(
      'geometry_entirely_on_land:land-area',
    );
  });

  it('flags an area outside Maltese national waters for manual review', () => {
    const notice = areaNotice(
      polygonArea('outside-waters', [
        { lat: 35.9, lon: 15.3 },
        { lat: 35.9, lon: 15.31 },
        { lat: 35.91, lon: 15.31 },
      ]),
    );

    expect(notice.needsReview).toBe(true);
    expect(notice.reviewReasons).toContain(
      'geometry_outside_maltese_waters:outside-waters',
    );
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
    // No AI: kind falls back to the deterministic document type. This fixture
    // quotes "prohibited", so it lands on 'alert' (the safe default).
    expect(out[0].kind).toBe('alert');
  });
});
