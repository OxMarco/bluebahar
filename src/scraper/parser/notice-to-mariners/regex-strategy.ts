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
  LAT_HEMI,
  LON_HEMI,
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
  String.raw`(?:\b([A-Z]\d?|\d{1,3}[A-Za-z])\.?\s+)?(\d{2,3})\s*${DEGREE_MARK}\s*(\d{2})\s*['\u2032]\s*\.?\s*(\d{1,3})${LAT_HEMI}\s+(0?\d{2,3})\s*${DEGREE_MARK}\s*(\d{2})\s*['\u2032]\s*\.?\s*(\d{1,3})${LON_HEMI}`,
  'g',
);

// Some notices label coordinates on the line ABOVE the row ("Position B:
// LATITUDE (N) LONGITUDE (E)\n36\u00b0 03'.620 ..."), so the row itself carries no
// label. Recover it from the immediately preceding text.
const POSITION_BACKREF_RE =
  /\b(?:position|point)\s+([A-Z]\d?)\s*:?\s*(?:LATITUDE\s*\(N\)\s*LONGITUDE\s*\(E\)\s*)?$/i;

function backrefLabel(text: string, idx: number): string | null {
  const m = text.slice(Math.max(0, idx - 70), idx).match(POSITION_BACKREF_RE);
  return m ? m[1] : null;
}

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
      label: m[1] ?? backrefLabel(text, m.index),
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

// Heading-ish line immediately above a coordinate block ("A) In Wied il-Ghasri
// (Gozo), the area joining the points A1, A2 and the intermediate coastline…"
// -> "In Wied il-Ghasri (Gozo)"). Returns null for table headers, boilerplate
// ("The limits of these areas are as follows:") and coordinate-row residue, so
// callers fall back to the notice title — without this, every area of a
// multi-block notice gets named after the global title and the per-block place
// names in the source are lost.
function blockTitle(text: string, idx: number): string | null {
  // Headings wrap across PDF text lines ("A) In Wied il-Ghasri (Gozo), the
  // area joining the points A1, A2 and the intermediate\ncoastline as shown
  // on attached chart A."), so join the preceding lines — dropping table
  // headers, page markers and coordinate rows — and take the last sentence.
  const degreeRow = new RegExp(String.raw`\d{1,3}\s*${DEGREE_MARK}`);
  const lines = text
    .slice(Math.max(0, idx - 400), idx)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter(
      (l) =>
        !/latitude|longitude|^points?\b|^position\b|^\(?[NE]\)?$/i.test(l) &&
        !/^--\s*\d+\s+of\s+\d+\s*--$/.test(l) &&
        !degreeRow.test(l),
    );
  if (!lines.length) return null;
  const joined = lines.join(' ');
  // An enumeration marker ("Q) In Il-Port il-Kbir …") anchors the heading
  // exactly; sentence splitting alone trips over abbreviations ("St. Peter's
  // Pool") and unterminated tails of the previous block.
  let t: string | undefined;
  const markers = [...joined.matchAll(/(?:^|\s)[A-Z]\)\s+[A-Z]/g)];
  const last = markers[markers.length - 1];
  if (last) {
    t = joined.slice(last.index).trim();
  } else {
    const chunks = joined
      .split(/(?<=[.!?])\s+|:\s*-?\s*/)
      .map((s) => s.trim())
      .filter((s) => /[A-Za-z]{3,}/.test(s));
    t = chunks[chunks.length - 1];
  }
  if (!t) return null;
  if (/\b(?:as follows|the following|are as|limits of)\b/i.test(t)) return null;
  if (/^\d{1,2}\s+[A-Za-z]+\s+\d{4}$/.test(t)) return null;
  const cleaned = t
    .replace(/^[A-Z]\)\s*/, '')
    // Cut at the first subordinate clause (", the area joining …", ", a
    // floating platform will be laid …") — the heading proper is what
    // precedes it.
    .replace(/,\s+(?=[a-z])[\s\S]*$/, '')
    .replace(/\s+as\s+shown\b[\s\S]*$/i, '')
    .replace(/\s*(?:shore|fairway)\s+point\s*$/i, '')
    .replace(/[,;:.\s]+$/, '')
    .trim()
    .slice(0, 90);
  return cleaned.length >= 3 ? cleaned : null;
}

// A gap between two coordinate rows that is pure boundary-recipe prose
// ("thence on a bearing of 335 True x 8.5 nautical miles to: Position B")
// links the rows into ONE shape; any other prose splits them into separate
// areas. The residue check rejects gaps that merely START with "thence" but
// continue into unrelated paragraphs.
function isRecipeLink(gap: string): boolean {
  if (!/^\s*[(,;.]?\s*thence\b/i.test(gap)) return false;
  const residue = gap
    .replace(
      /latitude|longitude|position|point|thence|bearing|true|arc|circle|radius|nautical|miles?|cent(?:red|ered|re|er)|degrees?/gi,
      ' ',
    )
    .replace(/\b(?:on|of|to|an|a|and|the|x)\b/gi, ' ')
    .replace(/[^A-Za-z]/g, '');
  return residue.length <= 12;
}

// Walk forward from `from`, chaining coordinates linked by recipe gaps. For
// the AFM firing-area recipes this recovers the full boundary (centre + rim)
// that prose-gap clustering would otherwise split point-by-point.
function thenceChain(
  coords: PosCoord[],
  from: PosCoord,
  text: string,
): PosCoord[] {
  const chain = [from];
  for (let i = coords.indexOf(from); i + 1 < coords.length; i++) {
    if (!isRecipeLink(text.slice(coords[i].end, coords[i + 1].idx))) break;
    chain.push(coords[i + 1]);
  }
  return chain;
}

// NM-radius mentions anchor circles and sectors. Both word orders occur in the
// source ("a radius of 4 Nautical miles", "8 Nautical Mile Radius") and the
// "of" is frequently omitted ("radius 8.5 nautical miles").
const RADIUS_NM_RE =
  /\bradius\s+(?:of\s+)?([\d.]+)\s*(?:NM\b|nautical\s+miles?)|([\d.]+)\s*(?:NM|nautical\s+miles?)\s+radius\b/gi;

// The centre of a radius mention: an explicit "centred on position/point X"
// label reference wins; then the legacy "centre point" phrase (centre = last
// coordinate stated before it); then the first free coordinate.
function resolveCentre(
  text: string,
  mentionIdx: number,
  free: PosCoord[],
): PosCoord | null {
  if (!free.length) return null;
  const near = text.slice(mentionIdx, mentionIdx + 250);
  const labelled = near.match(
    /cent(?:re|er)d?\s+(?:on|at)\s+(?:position|point)\s+([A-Z]\d?)\b/i,
  );
  if (labelled) {
    const hit = free.find((c) => c.label === labelled[1]);
    if (hit) return hit;
  }
  const ci = text.search(/cent(?:re|er)\s*point/i);
  if (ci >= 0) {
    const before = free.filter((c) => c.idx < ci);
    if (before.length) return before[before.length - 1];
  }
  return free[0];
}

// One circle/sector per "radius X NM" mention. Earlier code took only the
// FIRST mention and returned immediately, so a notice with two firing areas
// (Gunex: a Pembroke sector AND a Melita circle) lost everything but one
// shape, and corridors in the same notice were dropped with it. Consumed
// coordinates are marked so the catch-all below only sees the rest.
function radiusAreas(
  text: string,
  coords: PosCoord[],
  notice: string,
  title: string | null,
  hazard: string,
  consumed: Set<PosCoord>,
): Area[] {
  const mentions = [...text.matchAll(RADIUS_NM_RE)];
  const out: Area[] = [];
  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    const radius_nm = Number(m[1] ?? m[2]);
    if (!Number.isFinite(radius_nm) || radius_nm <= 0) continue;
    // Each mention owns the text between its neighbours, so coordinates can't
    // be claimed by a far-away radius phrase.
    const start =
      i === 0 ? 0 : mentions[i - 1].index + mentions[i - 1][0].length;
    const end = mentions[i + 1]?.index ?? text.length;
    const free = coords.filter(
      (c) => !consumed.has(c) && c.idx >= start && c.idx < end,
    );
    const centre = resolveCentre(text, m.index, free);
    if (!centre) continue;
    // Rim points: prefer the explicit boundary recipe chained off the centre
    // ("thence … to Position B thence on an arc … to Position C"); fall back
    // to "free points at roughly the stated radius from the centre".
    let rim = thenceChain(
      coords.filter((c) => !consumed.has(c)),
      centre,
      text,
    ).slice(1);
    if (rim.length < 2) {
      const km = radius_nm * 1.852;
      rim = free.filter(
        (c) => c !== centre && Math.abs(distanceKm(centre, c) - km) < km * 0.25,
      );
    }
    const idSuffix = mentions.length > 1 ? `-${i + 1}` : '';
    const mk = (c: PosCoord, j: number) => ({
      label: c.label ?? (j === 0 ? 'A' : `P${j}`),
      lat: c.lat,
      lon: c.lon,
    });
    consumed.add(centre);
    if (rim.length >= 2) {
      rim.forEach((c) => consumed.add(c));
      out.push({
        area_id: `${notice}-sector${idSuffix}`,
        name: title ?? titleNear(text, centre.idx) ?? 'Restricted area',
        chart: null,
        zone_color: null,
        hazard_type: hazard,
        operation: 'new',
        geometry_kind: 'sector',
        point_labels: [centre, ...rim].map((c, j) => mk(c, j).label),
        points: [centre, ...rim].map(mk),
        radius_nm,
        buffer_m: null,
        restrictions: [
          `Sector of radius ${radius_nm} NM between the two rim radii`,
        ],
      });
    } else {
      out.push({
        area_id: `${notice}-circle${idSuffix}`,
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
        restrictions: [`Circle radius ${radius_nm} NM about centre point`],
      });
    }
  }
  return out;
}

// "A1".."A4" share prefix "A"; "1a".."1f" share prefix "1". Bare labels ("A",
// "P3") have no prefix.
function labelPrefix(label: string | null): string | null {
  if (!label) return null;
  const m =
    label.match(/^([A-Za-z])(\d{1,3})$/) ??
    label.match(/^(\d{1,3})([A-Za-z])$/);
  return m ? m[1] : null;
}

type Block = { pts: PosCoord[]; prefix: string | null };

// A contiguous coordinate table often lists SEVERAL zones back to back
// (Mellieha: A1..A4 B1..B6 … N1..N4 with nothing but the labels separating
// them). Joining them into one ring produces the self-intersecting zigzags
// this splitter exists to prevent: when every point is labelled and the
// labels form ≥2 contiguous prefix runs of ≥2 points, each run is its own
// zone.
function splitByLabelPrefix(group: PosCoord[]): Block[] {
  const whole: Block[] = [{ pts: group, prefix: null }];
  if (group.length < 4) return whole;
  const prefixes = group.map((c) => labelPrefix(c.label));
  if (prefixes.some((p) => p === null)) return whole;
  const runs: PosCoord[][] = [[group[0]]];
  for (let i = 1; i < group.length; i++) {
    if (prefixes[i] === prefixes[i - 1]) runs[runs.length - 1].push(group[i]);
    else runs.push([group[i]]);
  }
  if (runs.length < 2 || runs.some((r) => r.length < 2)) return whole;
  const seen = new Set<string>();
  for (const r of runs) {
    const p = labelPrefix(r[0].label)!;
    if (seen.has(p)) return whole; // interleaved labels: not a zone table
    seen.add(p);
  }
  return runs.map((pts) => ({ pts, prefix: labelPrefix(pts[0].label) }));
}

// Per-row annotations: "… Shore" / "(Shore)" AFTER the row marks a point on
// the shoreline; "Shore Point …" / "Fairway Point …" BEFORE the row is the
// launch-lane table layout.
function shoreAnnotated(text: string, c: PosCoord): boolean {
  return /^\s*\(?\s*shore\b/i.test(text.slice(c.end, c.end + 12));
}

function rowAnnotation(text: string, c: PosCoord): 'shore' | 'fairway' | null {
  const back = text.slice(Math.max(0, c.idx - 30), c.idx);
  if (/fairway\s+point\s*$/i.test(back)) return 'fairway';
  if (/shore\s+point\s*$/i.test(back)) return 'shore';
  return null;
}

// A launch-lane quad is listed as Shore, Fairway, Shore, Fairway (two cross
// lines); ringing them in that order draws a bow-tie. Swap the second pair.
function laneOrdered(text: string, pts: PosCoord[]): PosCoord[] {
  if (pts.length !== 4) return pts;
  const ann = pts.map((c) => rowAnnotation(text, c));
  if (
    ann[0] === 'shore' &&
    ann[1] === 'fairway' &&
    ann[2] === 'shore' &&
    ann[3] === 'fairway'
  )
    return [pts[0], pts[1], pts[3], pts[2]];
  return pts;
}

// Phrases that mean "this open line is closed by the shore". Checked against
// the prose immediately before each block (not the whole notice, which would
// leak one block's closure onto every other block in the document).
const COASTLINE_CUE =
  /intermediate\s+coastline|the\s+coastline|either\s+side\s+of\s+the\s+bay|foreshore/i;

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

  // A) Circles / sectors anchored on "radius X NM" mentions. Consumes the
  // centre + rim coordinates; corridors and other tables in the same notice
  // fall through to the catch-all below instead of being dropped.
  const consumed = new Set<PosCoord>();
  const areas = radiusAreas(text, coords, notice, title, hazard, consumed);
  const remaining = coords.filter((c) => !consumed.has(c));
  if (!remaining.length) return areas;

  // B) "<Name> - The area bounded/formed by the imaginary line A to B [to C] and
  //    the intermediate coastline (chart N)." — one polygon per block.
  const anchorRe =
    /([^\n.]{3,90}?)\s*[-–]\s*The\s+area\s+(?:bounded|formed)\s+by\s+the\s+imaginary\s+line\s+([A-Z0-9][\sA-Z0-9to]*?)\s+and\s+the\s+intermediate\s+coastline[^.]*?(?:chart\s*(\d+))?\)?\./gi;
  const anchors = [...text.matchAll(anchorRe)];
  if (anchors.length) {
    const coastAreas: Area[] = [];
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const next = anchors[i + 1]?.index ?? text.length;
      const labels = a[2].match(/[A-Z]\d?/g) ?? [];
      const span = remaining.filter((c) => c.idx >= a.index && c.idx < next);
      const pts = span.slice(0, Math.max(labels.length, 2)).map((c, j) => ({
        label: labels[j] ?? c.label ?? `P${j + 1}`,
        lat: c.lat,
        lon: c.lon,
      }));
      if (pts.length < 2) continue;
      coastAreas.push({
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
    if (coastAreas.length) return [...areas, ...coastAreas];
  }

  // C) Catch-all: cluster coordinate rows into areas, splitting where descriptive
  //    prose sits between two rows (recipe prose like "thence on a bearing …"
  //    links rows instead of splitting them), then split label-prefixed zone
  //    tables. A lone coordinate is plotted as a Point exactly where the notice
  //    states it (no inference, so it needs no review); only the multi-point
  //    shapes we *join* here (lines/polygons) are flagged.
  const groups: PosCoord[][] = [];
  let cur: PosCoord[] = [];
  for (let i = 0; i < remaining.length; i++) {
    if (i > 0) {
      const gapText = text.slice(remaining[i - 1].end, remaining[i].idx);
      const gap = gapText
        .replace(/latitude|longitude|point|position|\(n\)|\(e\)/gi, '')
        .replace(/[^A-Za-z]/g, '');
      if (gap.length > 10 && !isRecipeLink(gapText)) {
        if (cur.length) groups.push(cur);
        cur = [];
      }
    }
    cur.push(remaining[i]);
  }
  if (cur.length) groups.push(cur);

  const blocks: Array<Block & { group: number }> = groups.flatMap((g, gi) =>
    splitByLabelPrefix(g).map((b) => ({ ...b, group: gi })),
  );
  const cable = /cable/i.test(text);
  const kindOf = (b: Block, i: number): GeometryKind => {
    if (cable) return 'linestring';
    const g = b.pts;
    // The closure cue must sit in THIS block's introduction: from the previous
    // block's last row (or a bounded look-back for the first block) to the
    // block's first row.
    const ctxStart =
      i === 0
        ? Math.max(0, g[0].idx - 700)
        : blocks[i - 1].pts[blocks[i - 1].pts.length - 1].end;
    const context = text.slice(ctxStart, g[0].idx);
    const coast =
      COASTLINE_CUE.test(context) ||
      (g.length >= 2 &&
        shoreAnnotated(text, g[0]) &&
        shoreAnnotated(text, g[g.length - 1]));
    return coast && g.length >= 2
      ? 'polygon_coastline'
      : g.length >= 3
        ? 'polygon'
        : g.length === 2
          ? 'linestring'
          : 'point';
  };
  // Only the inferred multi-point shapes need a human to verify the geometry; a
  // single coordinate is unambiguous, so a notice that yields only Points is not
  // flagged and stays public.
  if (blocks.some((b, i) => kindOf(b, i) !== 'point'))
    notes.push('generic_extraction_verify_geometry');

  // One base name per source GROUP, looked up at the group's first row: the
  // prefix-split zones of one table share the table's heading (suffixed with
  // their zone tag below), they don't each scavenge the rows above them.
  const groupBases = groups.map(
    (g) =>
      (blocks.length > 1 ? blockTitle(text, g[0].idx) : null) ??
      title ??
      titleNear(text, g[0].idx) ??
      'Area',
  );
  const bases = blocks.map((b) => groupBases[b.group]);
  const blockAreas = blocks.map((b, i): Area => {
    const kind = kindOf(b, i);
    const guessed = kind !== 'point';
    const pts = kind === 'polygon' ? laneOrdered(text, b.pts) : b.pts;
    let name = bases[i];
    if (b.prefix) {
      const tag = /^[A-Za-z]$/.test(b.prefix)
        ? `Zone ${b.prefix.toUpperCase()}`
        : `Area ${b.prefix}`;
      name = `${name} — ${tag}`;
    } else if (
      blocks.length > 1 &&
      bases.filter((x) => x === bases[i]).length > 1
    ) {
      name = `${name} — area ${i + 1}`;
    }
    return {
      area_id: `${notice}-area-${i + 1}`,
      name,
      chart: null,
      zone_color: null,
      hazard_type: hazard,
      operation: 'new',
      geometry_kind: kind,
      point_labels: pts.map((c, j) => c.label ?? `P${j + 1}`),
      points: pts.map((c, j) => ({
        label: c.label ?? `P${j + 1}`,
        lat: c.lat,
        lon: c.lon,
      })),
      radius_nm: null,
      buffer_m: null,
      restrictions: guessed ? ['generic extraction — verify geometry'] : [],
    };
  });
  return [...areas, ...blockAreas];
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
