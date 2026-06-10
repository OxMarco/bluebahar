import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import * as core from './core';
import * as visionVerify from './vision-verify';
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

  it('plots a non-cable chart correction (foul area) as an auto-published point', () => {
    // A "Chart Correction" that is not a cable Insert/Delete/Amended block still
    // states a position. It must fall through to the generic extractor instead
    // of yielding no geometry — and a single stated position is unambiguous, so
    // it publishes without manual review.
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 80 of 2026
3 June 2026
Chart Correction - Foul area (Lost anchor and chain)
Mariners are notified that an anchor and chain have been lost within Bunkering Area 6.
Charts are to show a foul area with a 500m radius at the stated position.
Position Latitude (N) Longitude (E)
35° 57'.600 014° 29'.400
`);

    expect(notice.areas).toHaveLength(1);
    expect(notice.areas[0].geometryType).toBe('point');
    expect(notice.needsReview).toBe(false);
    expect(notice.reviewReasons).not.toContain(
      'generic_extraction_verify_geometry',
    );
    // The "500m radius" becomes the notice's berth distance, which the app draws
    // as a ring around the point.
    expect(notice.distance).toBe(500);
  });

  it('accepts Transport Malta private-use degree glyphs in coordinate rows', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 82 of 2026
3 June 2026
Chart Correction - Foul area (Lost anchor and chain)
Mariners are notified that an anchor and chain were lost within Bunkering Area 6.
LATITUDE (N) LONGITUDE (E)
35\uF0B0 57'.233 014\uF0B0 19'.088
Insert symbol indicating a foul area with a 500m radius, in position.
`);

    expect(notice.areas).toHaveLength(1);
    expect(notice.areas[0].geometryType).toBe('point');
    expect(notice.areas[0].points[0].lat).toBeCloseTo(35.95388333);
    expect(notice.areas[0].points[0].long).toBeCloseTo(14.31813333);
    expect(notice.distance).toBe(500);
    expect(notice.needsReview).toBe(false);
  });

  it('flags coordinate-like rows when strict extraction misses the separator', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 83 of 2026
3 June 2026
Temporary restricted area
Mariners are notified that a restricted area is established.
Position Latitude (N) Longitude (E)
35 deg 57.233 014 deg 19.088
`);

    expect(notice.areas).toHaveLength(0);
    expect(notice.needsReview).toBe(true);
    expect(notice.reviewReasons).toContain('possible_coords_unparsed:1');
  });

  it('still flags a multi-point chart correction as inferred geometry', () => {
    // A chart correction whose positions get joined into a polygon is a guess,
    // so it stays in the review queue even though it now extracts geometry.
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 81 of 2026
3 June 2026
Chart Correction - New conservation area
Mariners are notified of a new conservation area at the stated positions.
Position Latitude (N) Longitude (E)
A 35° 55'.540 014° 28'.320
B 35° 59'.460 014° 27'.150
C 35° 58'.290 014° 32'.190
`);

    expect(notice.areas.length).toBeGreaterThan(0);
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

  it('splits a contiguous multi-zone label table into one polygon per zone', () => {
    // Mellieha-style table: zones A and B listed back to back with nothing but
    // the label prefixes separating them. One ring through all 8 points would
    // be a self-intersecting zigzag.
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 84 of 2026
3 June 2026
Mooring zones
Mariners are notified that mooring areas (Zones A and B) have been established.
The limits of these areas are as follows: -
LATITUDE (N) LONGITUDE (E)
A1 35° 58'.442 014° 21'.161
A2 35° 58'.607 014° 21'.476
A3 35° 58'.462 014° 21'.521
A4 35° 58'.399 014° 21'.205
B1 35° 58'.365 014° 21'.149
B2 35° 58'.441 014° 21'.527
B3 35° 58'.355 014° 21'.554
B4 35° 58'.337 014° 21'.464
`);
    const polys = notice.areas.filter((a) => a.geometryType === 'polygon');
    expect(polys.map((p) => p.label)).toEqual([
      'Mooring zones — Zone A',
      'Mooring zones — Zone B',
    ]);
    // 4 corners + closing point each, not one 8-point zigzag.
    expect(polys.map((p) => p.points.length)).toEqual([5, 5]);
  });

  it('parses coordinate rows with hemisphere suffixes and short longitude degrees', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 85 of 2026
3 June 2026
Launch lane
Mariners are notified of a launch lane.
Launch Lane 1 Shore Point 35° 58'.401N 14° 21'.003E
Fairway Point 35° 58'.424N 14° 21'.044E
`);
    expect(notice.areas).toHaveLength(1);
    expect(notice.areas[0].geometryType).toBe('line');
    expect(notice.areas[0].points[0].lat).toBeCloseTo(35.97335);
    expect(notice.areas[0].points[0].long).toBeCloseTo(14.35005);
  });

  it('accepts the letter "o" as a degree mark', () => {
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 86 of 2026
3 June 2026
Foul ground
Mariners are notified of foul ground at the following position.
LATITUDE (N) LONGITUDE (E)
35o 57'.112 14o 24'.497
`);
    expect(notice.areas).toHaveLength(1);
    expect(notice.areas[0].geometryType).toBe('point');
    expect(notice.areas[0].points[0].lat).toBeCloseTo(35.95186667);
  });

  it('closes a two-point bay-mouth line via the coastline on "either side of the bay"', () => {
    // St George's Bay phrasing: no "coastline" keyword, but the two points sit
    // on the shore either side of the bay and the restricted area is the
    // enclosed water — a bare line A-B would lose the area entirely.
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
LOCAL NOTICE TO MARINERS No 87 of 2026
3 June 2026
Entry Restriction in St. George's Bay
The restricted area is delineated by the imaginary line A to B, on the shore either side of
the bay (as shown on attached chart) and the sea area Southwest of the line.
LATITUDE (N) LONGITUDE (E)
A 35° 55'.666 014° 29'.461
B 35° 55'.593 014° 29'.518
`);
    expect(notice.areas).toHaveLength(1);
    expect(notice.areas[0].geometryType).toBe('polygon');
    // Coastline vertices stitched in, not just A-B-A.
    expect(notice.areas[0].points.length).toBeGreaterThan(4);
  });

  it('extracts every area of a multi-area firing notice: sector, circle and corridor', () => {
    // Gunex-style: a Pembroke arc recipe ("thence … radius … centred on
    // position A"), a transit corridor M-N, and a separate circular area at Z.
    // The old single-radius branch kept only one shape per notice.
    const notice = pipelineText(`
PORTS AND YACHTING DIRECTORATE
NOTICE TO MARINERS No 88 of 2026
3 June 2026
Live firing practice exercise at sea
At Pembroke ranges LM-D01
From Position A: LATITUDE (N) LONGITUDE (E)
35° 55'.900 014° 28'.533
thence on a bearing of 335 True x 8.5 nautical miles to:
Position B: LATITUDE (N) LONGITUDE (E)
36° 03'.620 014° 24'.100
thence on an arc of a circle radius 8.5 nautical miles centred on position A to:
Position C: LATITUDE (N) LONGITUDE (E)
36° 00'.150 014° 37'.600
thence on a bearing of 240 True to position A.
Mariners are also informed that a corridor between the coast and the line M to N has been
established for the passage of all vessels.
LATITUDE (N) LONGITUDE (E)
M 36° 02'.869 014° 24'.532
N 35° 58'.387 014° 33'.834
At south of Malta LM-D5
The exercise will be held within a circular area of 8 Nautical Mile Radius, centred on point
Z:
Position Z: LATITUDE (N) LONGITUDE (E)
35° 30'.500 014° 11'.000
`);
    const kinds = notice.areas.map((a) => a.geometryType);
    // sector polygon + circle polygon + corridor line
    expect(kinds.filter((k) => k === 'polygon')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'line')).toHaveLength(1);
    const line = notice.areas.find((a) => a.geometryType === 'line')!;
    expect(line.points).toHaveLength(2);
    expect(line.points[0].lat).toBeCloseTo(36.04781667);
  });

  it('flags sibling zones whose polygons overlap (transcription typo signature)', () => {
    const extraction: NoticeExtraction = {
      source_file: 'synthetic.pdf',
      notice_no: '98',
      notice_year: '2026',
      date: '2026-06-03',
      title: 'Synthetic zones',
      document_type: 'new_restriction',
      valid_from: '2026-06-03',
      valid_to: null,
      referenced_notices: [],
      charts_affected: [],
      areas: [
        polygonArea('zone-a', [
          { lat: 35.95, lon: 14.4 },
          { lat: 35.95, lon: 14.45 },
          { lat: 35.99, lon: 14.45 },
          { lat: 35.99, lon: 14.4 },
        ]),
        polygonArea('zone-b', [
          { lat: 35.96, lon: 14.42 }, // strictly inside zone-a
          { lat: 35.96, lon: 14.5 },
          { lat: 35.97, lon: 14.5 },
        ]),
      ],
    };
    const notice = adaptToParsedNotice({
      source: 'file://synthetic.pdf',
      extraction,
      featureCollection: buildFeatureCollection(extraction),
      enrichment: null,
      notes: ['coords:7'],
    });
    expect(
      notice.reviewReasons.some((r) => r.startsWith('overlaps_sibling_area:')),
    ).toBe(true);
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
  const activeNot35Now = new Date('2026-06-08T15:00:00.000Z');

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
      { now: activeNot35Now },
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
      { now: activeNot35Now },
    );

    expect(out[0].areas.length).toBeGreaterThan(0);
    expect(out[0].description).toContain('New restriction.');
  });

  it('skips enrichment but still yields a record for an already-expired notice', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    const create = jest.fn();

    // Not_35_of_2026 is valid through 2026-06-08; reference a later "now".
    const now = new Date('2026-06-09T00:00:00.000Z');
    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(create),
      { now },
    );

    // The record is persisted (its past activeTo hides it from public getters
    // and its source dedups the URL out of future scrape cycles); only the
    // pointless LLM call is skipped.
    expect(out).toHaveLength(1);
    expect(out[0].activeTo).toBeDefined();
    expect(out[0].activeTo!.getTime()).toBeLessThan(now.getTime());
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
      { now: activeNot35Now },
    );

    expect(out).toHaveLength(1);
  });

  it('flags the record for review when vision verification reports a mismatch', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    jest.spyOn(visionVerify, 'verifyExtractionWithVision').mockResolvedValue({
      verdict: 'mismatch',
      discrepancies: ['chart shows a wedge ABC, extraction has 3 bare points'],
      summary: 'Chart depicts sector ABC.',
    });

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(jest.fn()),
      { now: activeNot35Now, enrich: false, visionVerify: true },
    );

    expect(out[0].needsReview).toBe(true);
    expect(
      out[0].reviewReasons.some((r) => r.startsWith('vision_mismatch:')),
    ).toBe(true);
    // Geometry is untouched by the verdict.
    expect(out[0].areas.length).toBeGreaterThan(0);
  });

  it('keeps a vision match informational — no review flag', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    jest.spyOn(visionVerify, 'verifyExtractionWithVision').mockResolvedValue({
      verdict: 'match',
      discrepancies: [],
      summary: 'Chart matches the extracted sector.',
    });

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(jest.fn()),
      { now: activeNot35Now, enrich: false, visionVerify: true },
    );

    expect(out[0].needsReview).toBe(false);
  });

  it('keeps the deterministic result when vision verification throws', async () => {
    jest
      .spyOn(core, 'readPdfTextFromBuffer')
      .mockResolvedValue(fixture('Not_35_of_2026'));
    jest
      .spyOn(visionVerify, 'verifyExtractionWithVision')
      .mockRejectedValue(new Error('model offline'));

    const out = await extractNoticeFromBuffer(
      new Uint8Array(),
      'file://Not_35_of_2026.pdf',
      fakeOpenAI(jest.fn()),
      { now: activeNot35Now, enrich: false, visionVerify: true },
    );

    expect(out).toHaveLength(1);
    expect(out[0].areas.length).toBeGreaterThan(0);
    expect(out[0].needsReview).toBe(false);
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
