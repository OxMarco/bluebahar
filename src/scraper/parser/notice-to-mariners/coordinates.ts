import type { PdfLine } from './pdf-text';

// Deterministic coordinate extraction. The LLM never produces coordinates —
// only classifies sections. This module is the single source of truth for
// any lat/long that ends up in the database.
//
// Maltese NTM PDFs use DMS with decimal minutes:
//   "35° 54'.731 N"   "014° 29'.564 E"   "36° 01'.739"   "014° 22'.564"
// Direction letters are sometimes in the column header rather than per-row.
// Decimal-degrees form is rare but supported as a fallback.

export interface CoordHit {
  lat: number;
  long: number;
  // Source table point label when present (e.g. A, B, W, 1). Used to keep
  // multi-part notices from collapsing into one implied polygon.
  pointLabel?: string;
  // Where the pair was found, for heading-anchored section assignment.
  page: number;
  lineIdx: number;
  // X position of the latitude on the page, used for column-aware section
  // assignment (a coord in the right column shouldn't get attributed to a
  // left-column heading even if both share a Y band).
  x: number;
  y: number;
  // Original strings, for debugging and Sentry context.
  rawLat: string;
  rawLong: string;
}

// Degree symbol class. Some PDFs embed a custom font that maps the degree
// glyph to a Private Use Area codepoint instead of U+00B0; pdfjs surfaces it
// at whatever codepoint the font's CMap declared. We've seen U+F0B0 in
// production NTMs — extend this class as new PUA mappings show up.
const DEG = '[°\\uF0B0]';

// Degree-minute-decimal-minute pattern. Examples it matches:
//   35° 54'.731     35° 54'.731 N     014° 29'.564 E     35°54.731'N
// Groups: deg, min, decimals, hemisphere(optional).
//
// Decimals are fixed at 3 digits — Maltese NTM convention. A wider window
// (e.g. \d{0,5}) would silently over-consume the leading digits of the next
// coord on rows where pdfjs concatenates lat+long with no separator (a
// failure mode introduced by PDFs whose embedded font puts the degree glyph
// in a Private Use codepoint, defeating column-gap detection).
const DMS_RE = new RegExp(
  `(\\d{1,3})\\s*${DEG}\\s*(\\d{1,2})\\s*['′’]?\\s*\\.?\\s*(\\d{3})\\s*['′’]?\\s*([NSEW])?`,
  'gi',
);

// Fallback for PDFs whose extraction loses the degree symbol entirely (the
// glyph is absent from the embedded font, so pdfjs emits nothing for it).
// Coordinates come out as compact "DDMM'.DDD" tokens (e.g. "3554'.290" for
// 35°54'.290"). The decimal portion is fixed at 3 digits (Maltese NTM
// convention) so the regex can match consecutive coords with no separator
// between them — which happens when pdfjs concatenates a row's columns into
// one string. Handles both 2-digit (35) and 3-digit (014) degree forms by
// length: 4 leading digits → DD MM, 5 leading → DDD MM.
const DMS_NO_DEGREE_RE = /(\d{4,5})['′’]\.(\d{3})/g;

// Decimal-degrees fallback: "35.9155° N", "35.9155°", or "35.9155 N".
// Conservative: requires a degree marker or a hemisphere letter to avoid
// matching arbitrary numbers in the document (e.g. distances, channel numbers).
const DEC_RE = new RegExp(
  `(-?\\d{1,3}\\.\\d{2,7})\\s*(?:${DEG}\\s*([NSEW])?|([NSEW]))`,
  'gi',
);

function dmsToDecimal(
  deg: string,
  min: string,
  decimals: string,
  hemisphere: string | undefined,
): number {
  const d = parseInt(deg, 10);
  // Decimal minutes: "54'.731" means 54.731 minutes. The decimal portion may
  // be missing (whole minutes only).
  const m = parseFloat(decimals ? `${min}.${decimals}` : min);
  let value = d + m / 60;
  if (hemisphere) {
    const h = hemisphere.toUpperCase();
    if (h === 'S' || h === 'W') value = -value;
  }
  return value;
}

interface RawHit {
  value: number;
  isLat: boolean | null; // null = ambiguous (no hemisphere letter)
  raw: string;
  pointLabel?: string;
  // The line that produced this hit — needed because we pair across lines.
  page: number;
  lineIdx: number;
  // X position of the line containing this hit. Used for column-aware
  // section assignment downstream and for ordering hits within a Y band.
  x: number;
  y: number;
}

// Same-Y tolerance for pairing hits across split lines on the same row.
// Slightly looser than the row clustering tolerance to accommodate
// minor superscript / subscript drift.
const PAIR_Y_TOLERANCE = 6;

function extractPointLabel(
  text: string,
  matchIndex: number | undefined,
): string | undefined {
  const prefix = text.slice(0, matchIndex ?? 0).trim();
  const m = prefix.match(/(?:^|\s)([A-Za-z]{1,3}|\d{1,3})$/);
  return m?.[1]?.toUpperCase();
}

function parseLine(line: PdfLine): RawHit[] {
  const text = line.text;
  const hits: RawHit[] = [];

  for (const m of text.matchAll(DMS_RE)) {
    const [, deg, min, decimals, hem] = m;
    if (!min) continue; // bare degrees without minutes — too ambiguous
    const value = dmsToDecimal(deg, min, decimals, hem);
    const isLat =
      hem?.toUpperCase() === 'N' || hem?.toUpperCase() === 'S'
        ? true
        : hem?.toUpperCase() === 'E' || hem?.toUpperCase() === 'W'
          ? false
          : null;
    hits.push({
      value,
      isLat,
      raw: m[0],
      pointLabel: extractPointLabel(text, m.index),
      page: line.page,
      lineIdx: line.lineIdx,
      x: line.xStart,
      y: line.y,
    });
  }

  // If DMS already covered the line, skip the other patterns — they would
  // double-match degrees we've already parsed.
  if (hits.length > 0) return hits;

  // No-degree-symbol fallback (PDFs where pdfjs lost the ° glyph).
  for (const m of text.matchAll(DMS_NO_DEGREE_RE)) {
    const [, prefix, decimals] = m;
    // 4-digit prefix → 2 deg + 2 min (e.g. "3554" = 35°54)
    // 5-digit prefix → 3 deg + 2 min (e.g. "01430" — uncommon but allowed)
    const degLen = prefix.length === 5 ? 3 : 2;
    const deg = prefix.slice(0, degLen);
    const min = prefix.slice(degLen);
    const value = dmsToDecimal(deg, min, decimals, undefined);
    hits.push({
      value,
      isLat: null,
      raw: m[0],
      pointLabel: extractPointLabel(text, m.index),
      page: line.page,
      lineIdx: line.lineIdx,
      x: line.xStart,
      y: line.y,
    });
  }
  if (hits.length > 0) return hits;

  for (const m of text.matchAll(DEC_RE)) {
    const [, num, hemAfterDegree, hemOnly] = m;
    const hem = hemAfterDegree ?? hemOnly;
    let value = parseFloat(num);
    if (hem) {
      const h = hem.toUpperCase();
      if (h === 'S' || h === 'W') value = -Math.abs(value);
    }
    const isLat =
      hem?.toUpperCase() === 'N' || hem?.toUpperCase() === 'S'
        ? true
        : hem?.toUpperCase() === 'E' || hem?.toUpperCase() === 'W'
          ? false
          : null;
    hits.push({
      value,
      isLat,
      raw: m[0],
      pointLabel: extractPointLabel(text, m.index),
      page: line.page,
      lineIdx: line.lineIdx,
      x: line.xStart,
      y: line.y,
    });
  }

  return hits;
}

// Pair raw hits within a single Y band into lat/long pairs. Strategy:
//   1. Sort by x ascending (reading order across columns).
//   2. If hemispheres tell us — pair N/S with the nearest E/W on the right.
//   3. Otherwise, pair sequentially (1st, 2nd) (3rd, 4th) ... — Maltese NTM
//      tables uniformly list latitude first.
//   4. An odd hit count discards the trailing unpaired hit.
//
// Pairing across the Y band rather than within a single line is what makes
// PDFs with wide intra-table column gaps (lat | long > 70u apart) work,
// without giving up column separation between side-by-side tables — the
// latter still get distinct headings via the X-overlap rule downstream.
function pairHits(hits: RawHit[]): { latRaw: RawHit; longRaw: RawHit }[] {
  if (hits.length < 2) return [];
  const sorted = [...hits].sort((a, b) => a.x - b.x);

  const pairs: { latRaw: RawHit; longRaw: RawHit }[] = [];
  const labelled = sorted.filter((h) => h.isLat !== null);
  if (labelled.length === sorted.length && labelled.length % 2 === 0) {
    for (let i = 0; i < sorted.length; i += 2) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.isLat && b.isLat === false) pairs.push({ latRaw: a, longRaw: b });
      else if (a.isLat === false && b.isLat)
        pairs.push({ latRaw: b, longRaw: a });
    }
    if (pairs.length === sorted.length / 2) return pairs;
  }

  for (let i = 0; i + 1 < sorted.length; i += 2) {
    pairs.push({ latRaw: sorted[i], longRaw: sorted[i + 1] });
  }
  return pairs;
}

export function extractCoordinates(lines: PdfLine[]): CoordHit[] {
  // Collect all hits first, with their (page, y, x) provenance.
  const allHits: RawHit[] = [];
  for (const line of lines) {
    allHits.push(...parseLine(line));
  }

  // Group by (page, y-band) so pairs on the same physical row stay together
  // even if the line splitter put lat and long in different segments.
  type Band = { page: number; y: number; hits: RawHit[] };
  const bands: Band[] = [];
  for (const h of allHits) {
    const band = bands.find(
      (b) => b.page === h.page && Math.abs(b.y - h.y) <= PAIR_Y_TOLERANCE,
    );
    if (band) band.hits.push(h);
    else bands.push({ page: h.page, y: h.y, hits: [h] });
  }

  const out: CoordHit[] = [];
  for (const band of bands) {
    for (const { latRaw, longRaw } of pairHits(band.hits)) {
      out.push({
        lat: latRaw.value,
        long: longRaw.value,
        ...(latRaw.pointLabel !== undefined && {
          pointLabel: latRaw.pointLabel,
        }),
        page: latRaw.page,
        lineIdx: latRaw.lineIdx,
        x: latRaw.x,
        y: latRaw.y,
        rawLat: latRaw.raw.trim(),
        rawLong: longRaw.raw.trim(),
      });
    }
  }
  return out;
}

// Generous Malta maritime region. Anything outside is almost certainly a
// regex/PDF-text error (line-pairing crossed a column boundary, mojibake on
// the degree symbol, etc.) rather than a real Maltese notice.
export const MALTA_REGION_BBOX = {
  minLat: 35.5,
  maxLat: 36.5,
  minLong: 13.5,
  maxLong: 15.0,
} as const;

// Conservative inland polygons (well inside the actual coastline) for Malta
// and Gozo. Coordinates are [long, lat]. Coastal points stay valid so we don't
// flag legitimate harbour/wreck notices on land just because the centroid is
// near shore.
const MALTA_LAND_POLYGONS: [number, number][][] = [
  [
    [14.4, 35.93],
    [14.49, 35.93],
    [14.51, 35.89],
    [14.49, 35.85],
    [14.42, 35.84],
    [14.36, 35.86],
    [14.35, 35.89],
    [14.36, 35.92],
    [14.4, 35.93],
  ],
  [
    [14.25, 36.06],
    [14.3, 36.05],
    [14.3, 36.03],
    [14.26, 36.03],
    [14.23, 36.04],
    [14.25, 36.06],
  ],
];

function pointInRing(
  lng: number,
  lat: number,
  ring: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function validateAreaCoordinates(
  area: { lat: number; long: number }[],
): string[] {
  const errors: string[] = [];
  for (const { lat, long } of area) {
    if (
      lat < MALTA_REGION_BBOX.minLat ||
      lat > MALTA_REGION_BBOX.maxLat ||
      long < MALTA_REGION_BBOX.minLong ||
      long > MALTA_REGION_BBOX.maxLong
    ) {
      errors.push(
        `(${lat}, ${long}) is outside the Malta maritime region — regex pairing may have crossed columns or PDF text was malformed`,
      );
      continue;
    }
    if (MALTA_LAND_POLYGONS.some((ring) => pointInRing(long, lat, ring))) {
      errors.push(
        `(${lat}, ${long}) falls on Maltese land — re-check the source coordinates`,
      );
    }
  }
  return errors;
}
