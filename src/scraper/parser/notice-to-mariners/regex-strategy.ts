// Deterministic / rule-based extraction. No API. Fast, free, reproducible.
// Vendored from the mariner-parser project (bench/strategies/regex.ts) and
// refactored to run on already-extracted PDF text (the scraper reads the buffer
// once upstream in core.ts).
import {
  extractMetadata,
  extractCoordinates,
  classifyDocumentType,
  inferHazardType,
  extractValidityWindow,
  countPossibleCoordinateRows,
  parseDmm,
  inBbox,
  resolveLabels,
  DEGREE_MARK,
  type RawCoord,
} from './core';
import { distanceKm } from './spatial';
import type {
  Area,
  GeometryKind,
  NoticeExtraction,
  Operation,
  StrategyMeta,
} from './types';

function labelsInOrder(recipe: string): string[] {
  const seq = Array.from(recipe.matchAll(/\b\d{1,3}[A-Z]\b/g), (m) => m[0]);
  // dedupe consecutive repeats but keep first-seen order overall
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of seq)
    if (!seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  return out;
}

type Section = { name: string; chart: string | null; text: string };

function extractChartSections(text: string): Section[] {
  const headingRe = /^(.{2,80}?)\s+-\s+Chart\s+(\d+)\s*$/gim;
  const matches = Array.from(text.matchAll(headingRe));
  const sections: Section[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index ?? 0;
    const end = matches[i + 1]?.index ?? text.length;
    sections.push({
      name: m[1].trim(),
      chart: `Chart ${m[2]}`,
      text: text.slice(start, end).trim(),
    });
  }
  return sections;
}

function splitZones(
  sectionText: string,
): Array<{ color: 'red' | 'blue' | null; text: string }> {
  const zoneRe =
    /((?:shown in|is shown in|The restricted area is shown in)\s+(red|blue)[\s\S]*?)(?=(?:shown in|is shown in|The restricted area is shown in)\s+(?:red|blue)|Position\s+Latitude|Mariners\s+are|Notice\s+to\s+Mariners|$)/gi;
  const zones = Array.from(sectionText.matchAll(zoneRe), (m) => ({
    color: m[2].toLowerCase() as 'red' | 'blue',
    text: m[1].trim(),
  }));
  return zones.length ? zones : [{ color: null, text: sectionText }];
}

function geometryForZone(zoneText: string): {
  kind: GeometryKind;
  labels: string[];
  radius_nm: number | null;
  buffer_m: number | null;
  centerLabel: string | null;
} {
  const circle = zoneText.match(
    /circle\s+of\s+radius\s+([0-9]+(?:\.[0-9]+)?)\s*NM\s+cent(?:red|ered)\s+on\s+point\s+(\d{1,3}[A-Z])/i,
  );
  if (circle)
    return {
      kind: 'circle',
      labels: [circle[2]],
      radius_nm: Number(circle[1]),
      buffer_m: null,
      centerLabel: circle[2],
    };

  const buffer = zoneText.match(
    /minimum\s+distance\s+of\s+([0-9]+(?:\.[0-9]+)?)\s*m\s+from\s+the\s+clif/i,
  );
  if (buffer)
    return {
      kind: 'cliff_buffer',
      labels: [],
      radius_nm: null,
      buffer_m: Number(buffer[1]),
      centerLabel: null,
    };

  const labels = labelsInOrder(zoneText);
  const mentionsCoast = /coastline|coast\b/i.test(zoneText);
  if (!labels.length)
    return {
      kind: 'none',
      labels,
      radius_nm: null,
      buffer_m: null,
      centerLabel: null,
    };
  if (mentionsCoast)
    return {
      kind: 'polygon_coastline',
      labels,
      radius_nm: null,
      buffer_m: null,
      centerLabel: null,
    };
  if (labels.length >= 3)
    return {
      kind: 'polygon',
      labels,
      radius_nm: null,
      buffer_m: null,
      centerLabel: null,
    };
  return {
    kind: 'linestring',
    labels,
    radius_nm: null,
    buffer_m: null,
    centerLabel: null,
  };
}

// Chart-correction blocks (notice 34): Insert / Delete / Amended, unlabeled coords -> cable linestrings.
function chartCorrectionAreas(
  text: string,
  coords: RawCoord[],
  notice: string,
): Area[] {
  const blocks: Array<{ op: Operation; span: string }> = [];
  const insert = text.match(/\bInsert:\s*([\s\S]*?)\bDelete:/i)?.[1];
  const del = text.match(
    /\bDelete:\s*([\s\S]*?)(?:The\s+Submarine\s+power\s+cable|Positions\s+are\s+referred|Amended)/i,
  )?.[1];
  const amended = text.match(
    /now\s+joins\s+the\s+following\s+positions:\s*([\s\S]*?)Positions\s+are\s+referred/i,
  )?.[1];
  if (insert) blocks.push({ op: 'insert', span: insert });
  if (del) blocks.push({ op: 'delete', span: del });
  if (amended) blocks.push({ op: 'amended', span: amended });

  const hazard = inferHazardType(text);
  return blocks.map(({ op, span }) => {
    const pts = coords
      .filter((c) => span.includes(c.raw))
      .map((c) => ({ label: c.label, lat: c.lat, lon: c.lon }));
    return {
      area_id: `${notice}-${op}`,
      name: 'Submarine power cable area',
      chart: null,
      zone_color: null,
      hazard_type: hazard,
      operation: op,
      geometry_kind: 'linestring',
      point_labels: pts.map((p) => p.label),
      points: pts,
      radius_nm: null,
      buffer_m: null,
      restrictions: [],
    };
  });
}

// Swimmer / figure notices (086): "Line joining points 20A, 20B, ... and the intermediate coastline".
function swimmerAreas(
  text: string,
  byLabel: Map<string, RawCoord>,
  notice: string,
): Area[] {
  const m = text.match(
    /Line joining points\s+([\s\S]*?)\b(?:and the intermediate coastline|\.)/i,
  );
  if (!m) return [];
  const labels = labelsInOrder(m[1]);
  if (!labels.length) return [];
  const nameMatch = text.match(/\d+\s+(Il-Bajja[^\n]*?)\s+refer to Figure/i);
  return [
    {
      area_id: `${notice}-swimmer`,
      name: nameMatch?.[1]?.trim() ?? 'Swimmer zone',
      chart: 'Figure 20',
      zone_color: null,
      hazard_type: 'swimmer_zone',
      operation: 'amended',
      geometry_kind: 'polygon_coastline',
      point_labels: labels,
      points: resolveLabels(labels, byLabel),
      radius_nm: null,
      buffer_m: null,
      restrictions: [
        'Swimmer zone — line joining points and the intermediate coastline',
      ],
    },
  ];
}

// ---- Generic fallback ---------------------------------------------------------------
// For notices outside the "<Name> - Chart N / Shown in red-blue" template.
type PosCoord = {
  idx: number;
  end: number;
  label: string | null;
  lat: number;
  lon: number;
  raw: string;
};

const GEN_ROW = new RegExp(
  String.raw`(?:\b([A-Z]\d?|\d{1,3}[A-Z])\.?\s+)?(\d{2,3})\s*${DEGREE_MARK}\s*(\d{2})\s*['\u2032]\s*\.?\s*(\d{1,3})\s+(0?\d{2,3})\s*${DEGREE_MARK}\s*(\d{2})\s*['\u2032]\s*\.?\s*(\d{1,3})`,
  'g',
);

function scanCoords(text: string): {
  coords: PosCoord[];
  outsideBbox: PosCoord[];
} {
  const coords: PosCoord[] = [];
  const outsideBbox: PosCoord[] = [];
  for (const m of text.matchAll(GEN_ROW)) {
    const lat = parseDmm(m[2], m[3], m[4]);
    const lon = parseDmm(m[5], m[6], m[7]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const coord = {
      idx: m.index,
      end: m.index + m[0].length,
      label: m[1] ?? null,
      lat,
      lon,
      raw: m[0].trim(),
    };
    if (!inBbox({ lat, lon })) {
      outsideBbox.push(coord);
      continue;
    }
    coords.push(coord);
  }
  return { coords, outsideBbox };
}

// Nearest preceding "title" line (the area/notice subject), skipping table headers.
function titleNear(text: string, idx: number): string | null {
  const lines = text
    .slice(0, idx)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/latitude|longitude|^point\b|^position\b|^\(?[NE]\)?$/i.test(l))
      continue;
    if (
      /[A-Za-z]{4,}/.test(l) &&
      !new RegExp(String.raw`^\d{1,3}\s*${DEGREE_MARK}`).test(l)
    )
      return l.replace(/\s*[-–]\s*$/, '').slice(0, 90);
  }
  return null;
}

function genericAreas(
  text: string,
  notice: string,
  title: string | null,
  notes: string[],
): Area[] {
  const scan = scanCoords(text);
  const coords = scan.coords;
  for (const dropped of scan.outsideBbox) {
    notes.push(
      `generic_coord_outside_malta_bbox:${dropped.label ?? '?'}:${dropped.raw}`,
    );
  }
  if (!coords.length) return [];
  const hazard = inferHazardType(text);

  // A) Circle / sector: "a radius of X NM" centred on a point.
  const rad = text.match(/radius of\s*([\d.]+)\s*(?:NM|nautical\s+miles)/i);
  if (rad) {
    const ci = text.search(/cent(?:re|er)\s*point/i);
    const centre =
      ci >= 0 && coords.filter((c) => c.idx < ci).length
        ? coords.filter((c) => c.idx < ci).slice(-1)[0]
        : coords[0];
    const radius_nm = Number(rad[1]);
    const km = radius_nm * 1.852;
    const rim = coords
      .filter((c) => c !== centre)
      .filter((c) => Math.abs(distanceKm(centre, c) - km) < km * 0.25);
    const mk = (c: PosCoord, i: number) => ({
      label: c.label ?? (i === 0 ? 'A' : `P${i}`),
      lat: c.lat,
      lon: c.lon,
    });
    if (rim.length >= 2) {
      return [
        {
          area_id: `${notice}-sector`,
          name: title ?? titleNear(text, centre.idx) ?? 'Restricted area',
          chart: null,
          zone_color: null,
          hazard_type: hazard,
          operation: 'new',
          geometry_kind: 'sector',
          point_labels: [centre, ...rim].map((c, i) => mk(c, i).label),
          points: [centre, ...rim].map(mk),
          radius_nm,
          buffer_m: null,
          restrictions: [
            `Sector of radius ${rad[1]} NM between the two rim radii`,
          ],
        },
      ];
    }
    return [
      {
        area_id: `${notice}-circle`,
        name: title ?? titleNear(text, centre.idx) ?? 'Restricted area',
        chart: null,
        zone_color: null,
        hazard_type: hazard,
        operation: 'new',
        geometry_kind: 'circle',
        point_labels: [centre.label ?? 'A'],
        points: [
          { label: centre.label ?? 'A', lat: centre.lat, lon: centre.lon },
        ],
        radius_nm,
        buffer_m: null,
        restrictions: [`Circle radius ${rad[1]} NM about centre point`],
      },
    ];
  }

  // B) "<Name> - The area bounded/formed by the imaginary line A to B [to C] and
  //    the intermediate coastline (chart N)." — one polygon per block.
  const anchorRe =
    /([^\n.]{3,90}?)\s*[-–]\s*The\s+area\s+(?:bounded|formed)\s+by\s+the\s+imaginary\s+line\s+([A-Z0-9][\sA-Z0-9to]*?)\s+and\s+the\s+intermediate\s+coastline[^.]*?(?:chart\s*(\d+))?\)?\./gi;
  const anchors = [...text.matchAll(anchorRe)];
  if (anchors.length) {
    const areas: Area[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const next = anchors[i + 1]?.index ?? text.length;
      const labels = a[2].match(/[A-Z]\d?/g) ?? [];
      const span = coords.filter((c) => c.idx >= a.index && c.idx < next);
      const pts = span.slice(0, Math.max(labels.length, 2)).map((c, j) => ({
        label: labels[j] ?? c.label ?? `P${j + 1}`,
        lat: c.lat,
        lon: c.lon,
      }));
      if (pts.length < 2) continue;
      areas.push({
        area_id: `${notice}-coast-${i + 1}`,
        name: a[1].trim(),
        chart: a[3] ? `Chart ${a[3]}` : null,
        zone_color: null,
        hazard_type: hazard,
        operation: 'new',
        geometry_kind: 'polygon_coastline',
        point_labels: pts.map((p) => p.label),
        points: pts,
        radius_nm: null,
        buffer_m: null,
        restrictions: [],
      });
    }
    if (areas.length) return areas;
  }

  // C) Catch-all: cluster coordinate rows into areas, splitting where descriptive
  //    prose sits between two rows. A lone coordinate is plotted as a Point
  //    exactly where the notice states it (no inference, so it needs no review);
  //    only the multi-point shapes we *join* here (lines/polygons) are flagged.
  const groups: PosCoord[][] = [];
  let cur: PosCoord[] = [];
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) {
      const gap = text
        .slice(coords[i - 1].end, coords[i].idx)
        .replace(/latitude|longitude|point|position|\(n\)|\(e\)/gi, '')
        .replace(/[^A-Za-z]/g, '');
      if (gap.length > 10) {
        if (cur.length) groups.push(cur);
        cur = [];
      }
    }
    cur.push(coords[i]);
  }
  if (cur.length) groups.push(cur);

  const cable = /cable/i.test(text);
  const coastline = /intermediate coastline|the\s+coastline/i.test(text);
  const kindFor = (g: PosCoord[]): GeometryKind =>
    cable
      ? 'linestring'
      : coastline && g.length >= 2
        ? 'polygon_coastline'
        : g.length >= 3
          ? 'polygon'
          : g.length === 2
            ? 'linestring'
            : 'point';
  // Only the inferred multi-point shapes need a human to verify the geometry; a
  // single coordinate is unambiguous, so a notice that yields only Points is not
  // flagged and stays public.
  if (groups.some((g) => kindFor(g) !== 'point'))
    notes.push('generic_extraction_verify_geometry');
  return groups.map((g, i) => {
    const kind = kindFor(g);
    const guessed = kind !== 'point';
    const base = title ?? titleNear(text, g[0].idx) ?? 'Area';
    return {
      area_id: `${notice}-area-${i + 1}`,
      name: groups.length > 1 ? `${base} — area ${i + 1}` : base,
      chart: null,
      zone_color: null,
      hazard_type: hazard,
      operation: 'new',
      geometry_kind: kind,
      point_labels: g.map((c, j) => c.label ?? `P${j + 1}`),
      points: g.map((c, j) => ({
        label: c.label ?? `P${j + 1}`,
        lat: c.lat,
        lon: c.lon,
      })),
      radius_nm: null,
      buffer_m: null,
      restrictions: guessed ? ['generic extraction — verify geometry'] : [],
    };
  });
}

function buildAreas(
  text: string,
  coords: RawCoord[],
  byLabel: Map<string, RawCoord>,
  notice: string,
  docType: string,
  title: string | null,
  notes: string[],
): Area[] {
  if (docType === 'chart_correction') {
    const cableAreas = chartCorrectionAreas(text, coords, notice);
    if (cableAreas.length) return cableAreas;
    // A chart correction that isn't a cable Insert/Delete/Amended block — a foul
    // area, wreck, buoy, navigational light, pontoon or coastline change — still
    // states a position. Fall through to the generic extractor the other notice
    // types use so the notice plots, instead of silently yielding no geometry.
  }

  const sections = extractChartSections(text);
  if (sections.length) {
    const areas: Area[] = [];
    for (const section of sections) {
      for (const zone of splitZones(section.text)) {
        const g = geometryForZone(zone.text);
        if (g.kind === 'none') continue;
        areas.push({
          area_id: `${notice}-${section.chart}-${zone.color ?? 'zone'}`,
          name: section.name,
          chart: section.chart,
          zone_color: zone.color,
          hazard_type:
            g.kind === 'cliff_buffer'
              ? 'coastal_buffer'
              : inferHazardType(zone.text),
          operation: 'new',
          geometry_kind: g.kind,
          point_labels: g.labels,
          points: resolveLabels(g.labels, byLabel),
          radius_nm: g.radius_nm,
          buffer_m: g.buffer_m,
          restrictions: [],
        });
      }
    }
    if (areas.length) return areas;
  }

  const swim = swimmerAreas(text, byLabel, notice);
  if (swim.length) return swim;

  const generic = genericAreas(text, notice, title, notes);
  if (generic.length) return generic;

  return []; // genuinely no plottable coordinates
}

// A stated safety berth in metres, e.g. "a foul area with a 500m radius" or
// "radius of 500 metres". Only metre radii are taken: a radius in NM is already
// realised as a circle polygon by geometry.ts, so reusing it as a berth would
// double-draw. The cliff-buffer phrasing ("minimum distance of X m from the
// cliff") has no "radius" and so never matches here.
const METRE_RADIUS_RE =
  /radius\s+of\s+(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b|(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\s+radius\b/i;

function extractSafetyDistanceM(text: string): number | null {
  const m = text.match(METRE_RADIUS_RE);
  if (!m) return null;
  const value = Number(m[1] ?? m[2]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type RegexResult = { extraction: NoticeExtraction; meta: StrategyMeta };

// Run the deterministic extraction over already-parsed PDF text. `sourceFile` is
// the basename used for `source_file`; `pages` feeds the scanned-PDF heuristic.
export function runRegex(
  text: string,
  pages: number,
  sourceFile: string,
): RegexResult {
  const meta = extractMetadata(text);
  const coords = extractCoordinates(text);
  const byLabel = new Map(coords.map((c) => [c.label, c]));
  const docType = classifyDocumentType(text);
  const noticeId = meta.notice_no ?? 'notice';
  const validity = extractValidityWindow(text, meta.date);

  // A near-empty text layer means the PDF is scanned images — regex can't see
  // anything. Flag it so the caller can surface a manual-review hint.
  const notes = [`coords:${coords.length}`];
  if (coords.length === 0) {
    const possible = countPossibleCoordinateRows(text);
    if (possible > 0) notes.push(`possible_coords_unparsed:${possible}`);
  }
  const areas = buildAreas(
    text,
    coords,
    byLabel,
    noticeId,
    docType,
    meta.title,
    notes,
  );

  const nonWs = text.replace(/\s/g, '').length;
  if (!coords.length && nonWs / Math.max(pages, 1) < 40) {
    notes.push('likely_scanned_pdf:empty_text_layer — needs OCR/manual review');
  }

  const extraction: NoticeExtraction = {
    source_file: sourceFile,
    notice_no: meta.notice_no,
    notice_year: meta.notice_year,
    date: meta.date,
    title: meta.title,
    document_type: docType,
    valid_from: validity.validFrom,
    valid_to: validity.validTo,
    referenced_notices: meta.referenced_notices,
    charts_affected: meta.charts_affected,
    areas,
    safety_distance_m: extractSafetyDistanceM(text),
  };
  return {
    extraction,
    meta: { notes },
  };
}
