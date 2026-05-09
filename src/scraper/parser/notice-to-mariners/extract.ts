// Wires together: PDF text extraction, deterministic coordinate regex, LLM
// outline (no coords), gazetteer lookup for facility-kind notices, and
// per-section validation. The LLM is structurally incapable of producing
// coordinates here — they come from regex (for 'area') or the gazetteer
// (for 'facility'), so a sign flip / DMS error / lat-long swap can no longer
// reach the database.

import OpenAI from 'openai';
import { fetchBuffer } from '../../../common/utils/http';
import { NoticeKind } from '../../notice-kind';
import {
  CoordHit,
  extractCoordinates,
  validateAreaCoordinates,
} from './coordinates';
import { entryToArea, lookupPlace } from './gazetteer';
import {
  callOutline,
  OutlineGeometryPart,
  OutlineGeometryType,
  OutlineRecord,
} from './outline';
import { extractPdfText, PdfLine } from './pdf-text';

export interface NoticePoint {
  lat: number;
  long: number;
}

export interface NoticeGeometryPart {
  label: string;
  geometryType: OutlineGeometryType;
  points: NoticePoint[];
}

export interface ParsedNotice {
  kind: NoticeKind;
  title: string;
  description: string;
  source: string;
  // Disambiguates multiple notices extracted from a single PDF. Empty string
  // when the PDF maps to one notice; otherwise a stable section identifier so
  // retries don't duplicate rows under unique(source, subKey).
  subKey: string;
  // Required for kind='facility', optional context for 'area', absent for 'advisory'.
  locationLabel?: string;
  publishedAt: Date;
  activeFrom: Date;
  activeTo?: Date;
  // Safety berth radius from the hazard, in metres. Top-level (one notice =
  // one safety distance); the polygon's vertices carry only the geometry.
  // Absent when the notice doesn't specify one.
  distance?: number;
  // Depth of the hazard itself in metres (e.g. wreck depth). Absent when
  // not stated.
  depth?: number;
  // Distinct geographic parts. The API serializer renders these into one
  // GeoJSON geometry (or GeometryCollection) per notice.
  areas: NoticeGeometryPart[];
  // Set when:
  //   - 'area' record had no usable coordinates after regex extraction
  //   - 'facility' locationLabel didn't resolve in the gazetteer
  //   - extracted coordinates failed Malta region/land checks
  // Flagged notices are persisted but hidden from public getters so a human
  // can curate (e.g. add a missing gazetteer entry).
  needsReview: boolean;
}

// Build a normalized lookup key matching the same scheme used in pdf-text.ts
// for whitespace collapsing — needed so that "Bunkering Area 1" in the LLM
// output matches "Bunkering Area 1" in the PDF lines regardless of stray
// whitespace differences.
function normalizeAnchor(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

interface HeadingHit {
  record: OutlineRecord;
  page: number;
  y: number;
  xStart: number;
  xEnd: number;
}

// Locate every PDF line whose normalized text CONTAINS a section's
// headingAnchor. Substring rather than exact match because Maltese NTM
// headings are commonly embedded in introductory sentences ("Ir-Ramla
// tal-Mixquqa, the area bounded by...") rather than appearing on a line of
// their own. When multiple anchors could match the same line, the longest
// anchor wins — keeps "Grand Harbour" from being claimed by a shorter
// "Harbour" anchor.
function findHeadingHits(
  lines: PdfLine[],
  records: OutlineRecord[],
): HeadingHit[] {
  const anchors = records
    .filter((r) => r.headingAnchor.length > 0)
    .map((r) => ({ record: r, needle: normalizeAnchor(r.headingAnchor) }))
    .sort((a, b) => b.needle.length - a.needle.length);

  const hits: HeadingHit[] = [];
  for (const line of lines) {
    const norm = normalizeAnchor(line.text);
    const match = anchors.find((a) => norm.includes(a.needle));
    if (!match) continue;
    hits.push({
      record: match.record,
      page: line.page,
      y: line.y,
      xStart: line.xStart,
      xEnd: line.xEnd,
    });
  }
  return hits;
}

// Assign each coordinate hit to the section whose heading is most directly
// "above" it on the page. A heading qualifies if:
//   - it's on the same page or earlier, AND
//   - if same page, its y is >= the coord's y (PDF y is bottom-up; "above"
//     means greater y), AND
//   - its x range overlaps the coord's x range (so a left-column heading
//     doesn't claim a right-column coord), AND
//   - the coord's page is within the heading's record pageStart..pageEnd.
// Among qualifying headings, the closest one wins: same page beats earlier
// page; smaller (heading.y - coord.y) within a page beats larger.
function assignCoordsToRecords(
  records: OutlineRecord[],
  coords: CoordHit[],
  lines: PdfLine[],
): Map<string, CoordHit[]> {
  const result = new Map<string, CoordHit[]>();
  for (const r of records) result.set(r.subKey, []);

  // Single-record PDF: all coords go to the lone record without anchoring.
  if (records.length === 1) {
    result.set(records[0].subKey, [...coords]);
    return result;
  }

  const headingHits = findHeadingHits(lines, records);

  for (const c of coords) {
    // Score candidates: (samePage ? 1 : 0) * 1e6 - verticalDelta. Higher = better.
    let best: { record: OutlineRecord; score: number } | null = null;
    for (const h of headingHits) {
      if (c.page < h.record.pageStart || c.page > h.record.pageEnd) continue;

      let score: number;
      if (h.page === c.page) {
        if (h.y < c.y) continue; // heading sits below the coord on the page
        // Coord's lat-x must fall inside the heading's horizontal range. This
        // is what stops a left-column heading from claiming a right-column
        // coord even when both share a Y band.
        if (c.x < h.xStart || c.x > h.xEnd) continue;
        score = 1_000_000 - (h.y - c.y);
      } else if (h.page < c.page) {
        // Heading on an earlier page — no x check; whole-page scope.
        score = -(c.page - h.page) * 10_000;
      } else {
        continue; // heading on a later page can't anchor this coord
      }
      if (!best || score > best.score) best = { record: h.record, score };
    }

    if (best) result.get(best.record.subKey)!.push(c);
  }
  return result;
}

interface BuiltArea {
  areas: NoticeGeometryPart[];
  // Defaulted from the gazetteer for facility points when the LLM didn't
  // extract a safety distance — gives the map something sensible to render
  // around a single coord. Overridden by the LLM-extracted distance below.
  fallbackDistance?: number;
  reviewReasons: string[];
}

function toPoint(c: CoordHit): NoticePoint {
  return { lat: c.lat, long: c.long };
}

function normalizePointLabel(label: string | undefined): string {
  return (label ?? '').trim().toUpperCase();
}

function inferGeometryType(points: NoticePoint[]): OutlineGeometryType {
  if (points.length <= 1) return 'point';
  if (points.length === 2) return 'line';
  return 'polygon';
}

function fallbackGeometryPart(
  label: string,
  coords: CoordHit[],
): NoticeGeometryPart {
  const points = coords.map(toPoint);
  return {
    label,
    geometryType: inferGeometryType(points),
    points,
  };
}

function buildGeometryParts(
  record: OutlineRecord,
  coords: CoordHit[],
  reviewReasons: string[],
): NoticeGeometryPart[] {
  const outlineParts = record.geometryParts ?? [];
  if (outlineParts.length === 0) {
    return [fallbackGeometryPart(record.title, coords)];
  }

  if (outlineParts.length === 1 && outlineParts[0].pointLabels.length === 0) {
    return [
      {
        label: outlineParts[0].label,
        geometryType: outlineParts[0].geometryType,
        points: coords.map(toPoint),
      },
    ];
  }

  if (outlineParts.length === 1 && coords.length === 1) {
    return [
      {
        label: outlineParts[0].label,
        geometryType: outlineParts[0].geometryType,
        points: coords.map(toPoint),
      },
    ];
  }

  const referenced = new Set<number>();
  const built = new Map<OutlineGeometryPart, NoticeGeometryPart>();
  const unlabeledParts = outlineParts.filter((p) => p.pointLabels.length === 0);

  for (const part of outlineParts) {
    if (part.pointLabels.length === 0) continue;

    const partCoords: CoordHit[] = [];
    for (const rawLabel of part.pointLabels) {
      const label = normalizePointLabel(rawLabel);
      const matches = coords
        .map((coord, i) => ({ coord, i }))
        .filter(({ coord }) => normalizePointLabel(coord.pointLabel) === label);
      if (matches.length > 1) {
        reviewReasons.push(
          `point label '${rawLabel}' matched ${matches.length} coordinates; geometry part '${part.label}' may need manual disambiguation`,
        );
      }
      const match = matches[0];
      if (!match) {
        reviewReasons.push(
          `geometry part '${part.label}' references point label '${rawLabel}' that was not extracted from the PDF`,
        );
        continue;
      }
      referenced.add(match.i);
      partCoords.push(match.coord);
    }

    if (partCoords.length > 0) {
      built.set(part, {
        label: part.label,
        geometryType: part.geometryType,
        points: partCoords.map(toPoint),
      });
    }
  }

  const unassigned = coords.filter((_, i) => !referenced.has(i));
  if (unassigned.length > 0 && unlabeledParts.length === 1) {
    const part = unlabeledParts[0];
    built.set(part, {
      label: part.label,
      geometryType: part.geometryType,
      points: unassigned.map(toPoint),
    });
  } else if (unassigned.length > 0) {
    reviewReasons.push(
      `${unassigned.length} coordinate(s) were not assigned to a declared geometry part`,
    );
    built.set(
      {
        label: 'Unassigned coordinates',
        geometryType: inferGeometryType(unassigned.map(toPoint)),
        headingAnchor: null,
        pointLabels: [],
      },
      fallbackGeometryPart('Unassigned coordinates', unassigned),
    );
  }

  const ordered = outlineParts
    .map((part) => built.get(part))
    .filter((part): part is NoticeGeometryPart => part !== undefined);
  const extra = [...built.entries()]
    .filter(([part]) => !outlineParts.includes(part))
    .map(([, part]) => part);

  const areas = [...ordered, ...extra];
  if (areas.length === 0) {
    return [fallbackGeometryPart(record.title, coords)];
  }
  return areas;
}

function flattenUniqueCoords(coords: CoordHit[]): NoticePoint[] {
  const seen = new Set<string>();
  const points: NoticePoint[] = [];
  for (const coord of coords) {
    const key = `${coord.lat}:${coord.long}`;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(toPoint(coord));
  }
  return points;
}

function buildArea(record: OutlineRecord, coords: CoordHit[]): BuiltArea {
  const reviewReasons: string[] = [];

  if (record.kind === NoticeKind.ADVISORY) {
    return { areas: [], reviewReasons };
  }

  if (record.kind === NoticeKind.AREA) {
    if (coords.length === 0) {
      reviewReasons.push(
        `kind='area' but no coordinates were extracted from the PDF for this section`,
      );
      return { areas: [], reviewReasons };
    }
    const areas = buildGeometryParts(record, coords, reviewReasons);
    reviewReasons.push(...validateAreaCoordinates(flattenUniqueCoords(coords)));
    // Anomaly check: a single geometry part with this many coords is almost
    // certainly multiple distinct regions that the grouping step collapsed.
    for (const part of areas.filter((p) => p.points.length > 30)) {
      reviewReasons.push(
        `geometry part '${part.label}' has ${part.points.length} coordinates — likely multiple regions merged into one part`,
      );
    }
    return { areas, reviewReasons };
  }

  // kind === 'facility' — resolve via gazetteer.
  const label = record.locationLabel?.trim();
  if (!label) {
    reviewReasons.push(`kind='facility' without a locationLabel`);
    return { areas: [], reviewReasons };
  }
  const entry = lookupPlace(label);
  if (!entry) {
    reviewReasons.push(
      `locationLabel '${label}' not found in gazetteer — add an entry to gazetteer.ts`,
    );
    return { areas: [], reviewReasons };
  }
  const points = entryToArea(entry);
  const areas: NoticeGeometryPart[] = [
    {
      label,
      geometryType: entry.kind === 'point' ? 'point' : 'polygon',
      points,
    },
  ];
  reviewReasons.push(...validateAreaCoordinates(points));
  // Point gazetteer entries carry a default rendering radius so single-coord
  // facilities have something to draw on the map even when the notice didn't
  // state a safety distance.
  const fallbackDistance = entry.kind === 'point' ? entry.distance : undefined;
  return { areas, fallbackDistance, reviewReasons };
}

function finalize(
  url: string,
  record: OutlineRecord,
  coords: CoordHit[],
): ParsedNotice {
  const { areas, fallbackDistance, reviewReasons } = buildArea(record, coords);

  return {
    kind: record.kind,
    title: record.title,
    description: record.description,
    source: url,
    subKey: record.subKey,
    ...(record.locationLabel !== null && {
      locationLabel: record.locationLabel,
    }),
    publishedAt: new Date(record.publishedAt),
    activeFrom: new Date(record.activeFrom),
    ...(record.activeTo !== null && { activeTo: new Date(record.activeTo) }),
    // LLM-extracted distance takes priority; gazetteer default fills in for
    // single-point facilities with no stated berth requirement.
    ...((record.distance ?? fallbackDistance) !== undefined && {
      distance: record.distance ?? fallbackDistance,
    }),
    ...(record.depth !== null && { depth: record.depth }),
    areas,
    needsReview: reviewReasons.length > 0,
  };
}

export async function extractNoticeFromPdf(
  url: string,
  openai: OpenAI,
): Promise<ParsedNotice[]> {
  const buffer = await fetchBuffer(url);
  return extractNoticeFromBuffer(buffer, url, openai);
}

// Buffer-based variant for offline testing (CLI scripts, fixtures). `source`
// is what gets stored on each ParsedNotice and is what the unique constraint
// uses — pass the canonical URL when available, or a stable file identifier.
export async function extractNoticeFromBuffer(
  buffer: Buffer,
  source: string,
  openai: OpenAI,
): Promise<ParsedNotice[]> {
  // Coord extraction depends only on lines; outline depends on joined text.
  // Sequencing keeps the OpenAI call in one place for easier latency tracing.
  const { lines, joined } = await extractPdfText(buffer);
  const coords = extractCoordinates(lines);
  const outline = await callOutline(source, openai, joined);

  const coordsByRecord = assignCoordsToRecords(outline, coords, lines);

  return outline.map((record) =>
    finalize(source, record, coordsByRecord.get(record.subKey) ?? []),
  );
}
