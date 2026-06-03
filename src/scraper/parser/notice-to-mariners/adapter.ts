// Bridges the mariner-parser's rich GeoJSON output back onto the backend's
// existing persistence model (NoticeToMariners). One PDF maps to ONE notice
// row, whose `areas` are the plottable features flattened into the entity's
// point/line/polygon geometry parts. Circles, sectors, cliff buffers and
// coastline-closed zones all arrive here already realised as their polygon
// rings, so they map to `geometryType: 'polygon'` with no loss for rendering.
import type { FeatureCollection, Geometry, Position } from 'geojson';
import { NoticeKind } from '../../notice-kind';
import type { DocumentType, NoticeExtraction } from './types';
import type { Enrichment } from './enrich';

export interface NoticePoint {
  lat: number;
  long: number;
}

export type NoticeGeometryType = 'point' | 'line' | 'polygon';

export interface NoticeGeometryPart {
  label: string;
  geometryType: NoticeGeometryType;
  points: NoticePoint[];
}

export interface ParsedNotice {
  kind: NoticeKind;
  title: string;
  description: string;
  source: string;
  // Empty string: one PDF maps to one notice. Kept for the entity's
  // unique(source, subKey) constraint so retries don't duplicate rows.
  subKey: string;
  locationLabel?: string;
  publishedAt: Date;
  activeFrom: Date;
  activeTo?: Date;
  distance?: number;
  depth?: number;
  areas: NoticeGeometryPart[];
  // True when geometry was missing/broken, a coordinate fell outside Malta, a
  // source typo was excluded, the PDF looked scanned, or a restriction notice
  // yielded no geometry despite carrying coordinates. Flagged rows are
  // persisted but hidden from public getters for human curation.
  needsReview: boolean;
}

export interface AdaptInput {
  source: string;
  extraction: NoticeExtraction;
  featureCollection: FeatureCollection<Geometry | null>;
  enrichment: Enrichment | null;
  // Strategy + enrichment notes (e.g. "coords:7", "likely_scanned_pdf:…").
  notes: string[];
}

function xy(c: Position): NoticePoint {
  return { lat: c[1], long: c[0] };
}

function suffix(label: string, i: number, total: number): string {
  return total > 1 ? `${label} (${i + 1})` : label;
}

// Flatten one GeoJSON geometry into the entity's geometry parts. Multi-* and
// GeometryCollection split into one part per sub-geometry. Polygons keep only
// their exterior ring (the serializer re-closes rings as needed).
function geometryToParts(
  geom: Geometry | null,
  label: string,
): NoticeGeometryPart[] {
  if (!geom) return [];
  switch (geom.type) {
    case 'Point':
      return [{ label, geometryType: 'point', points: [xy(geom.coordinates)] }];
    case 'MultiPoint':
      return geom.coordinates.map((c, i) => ({
        label: suffix(label, i, geom.coordinates.length),
        geometryType: 'point' as const,
        points: [xy(c)],
      }));
    case 'LineString':
      return [
        { label, geometryType: 'line', points: geom.coordinates.map(xy) },
      ];
    case 'MultiLineString':
      return geom.coordinates.map((line, i) => ({
        label: suffix(label, i, geom.coordinates.length),
        geometryType: 'line' as const,
        points: line.map(xy),
      }));
    case 'Polygon':
      return [
        { label, geometryType: 'polygon', points: geom.coordinates[0].map(xy) },
      ];
    case 'MultiPolygon':
      return geom.coordinates.map((poly, i) => ({
        label: suffix(label, i, geom.coordinates.length),
        geometryType: 'polygon' as const,
        points: poly[0].map(xy),
      }));
    case 'GeometryCollection':
      return geom.geometries.flatMap((g) => geometryToParts(g, label));
    default:
      return [];
  }
}

function referenceId(x: NoticeExtraction): string | null {
  return x.notice_no && x.notice_year
    ? `${x.notice_no}/${x.notice_year}`
    : null;
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  new_restriction: 'New restriction',
  amendment: 'Amendment to a Notice to Mariners',
  chart_correction: 'Chart correction',
  time_extension: 'Time extension',
  cancellation: 'Cancellation',
  unknown: 'Notice to Mariners',
};

// Deterministic description used when AI enrichment is off or failed. Built from
// the rule-based extraction (document type + hazards + restrictions).
function ruleBasedDescription(x: NoticeExtraction): string {
  const parts: string[] = [DOC_TYPE_LABELS[x.document_type] + '.'];

  const hazards = [
    ...new Set(
      x.areas
        .map((a) => a.hazard_type)
        .filter((h): h is string => Boolean(h) && h !== 'unknown'),
    ),
  ].map((h) => h.replace(/_/g, ' '));
  if (hazards.length) parts.push(`Hazard: ${hazards.join(', ')}.`);

  const restrictions = [
    ...new Set(x.areas.flatMap((a) => a.restrictions).filter(Boolean)),
  ];
  if (restrictions.length) parts.push(restrictions.join(' '));

  if (x.charts_affected.length)
    parts.push(`Charts affected: ${x.charts_affected.join(', ')}.`);

  const text = parts.join(' ').trim();
  return text || x.title || 'Notice to Mariners.';
}

function buildDescription(
  x: NoticeExtraction,
  enrichment: Enrichment | null,
): string {
  if (enrichment) {
    const segments = [enrichment.summary, enrichment.recommended_action]
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.length) return segments.join('\n\n');
  }
  return ruleBasedDescription(x);
}

function noticeCoordCount(notes: string[]): number {
  for (const n of notes) {
    const m = n.match(/^coords:(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

// Map the full mariner-parser result onto a single ParsedNotice row.
export function adaptToParsedNotice(input: AdaptInput): ParsedNotice {
  const { source, extraction, featureCollection, enrichment, notes } = input;

  const featureWarnings = featureCollection.features.flatMap(
    (f) => (f.properties?.warnings as string[] | undefined) ?? [],
  );

  const areas = featureCollection.features.flatMap((f) =>
    geometryToParts(
      f.geometry,
      (f.properties?.name as string) ??
        (f.properties?.area_id as string) ??
        'Area',
    ),
  );

  const publishedAt = parseDate(extraction.date) ?? new Date();
  const activeFrom = parseDate(extraction.valid_from) ?? publishedAt;
  const activeTo = parseDate(extraction.valid_to) ?? undefined;

  const title =
    extraction.title ||
    referenceId(extraction) ||
    extraction.source_file ||
    'Notice to Mariners';

  const firstAreaName = extraction.areas.find((a) => a.name)?.name ?? undefined;
  const locationLabel =
    enrichment?.affected_locations?.[0] ?? firstAreaName ?? undefined;

  // A coastline-closure fallback (straight-line close) is an approximation, not
  // a failure — the zone still plots — so it does not force manual review. Every
  // other warning (missing/degenerate geometry, out-of-bbox point, excluded
  // typo) does.
  const seriousWarnings = featureWarnings.filter(
    (w) => !w.startsWith('coastline_closure_fallback'),
  );
  const scanned = notes.some((n) => n.includes('likely_scanned_pdf'));
  const suspiciousEmpty =
    areas.length === 0 &&
    noticeCoordCount(notes) > 0 &&
    extraction.document_type === 'new_restriction';
  const needsReview = seriousWarnings.length > 0 || scanned || suspiciousEmpty;

  return {
    kind: areas.length > 0 ? NoticeKind.AREA : NoticeKind.ADVISORY,
    title,
    description: buildDescription(extraction, enrichment),
    source,
    subKey: '',
    ...(locationLabel ? { locationLabel } : {}),
    publishedAt,
    activeFrom,
    ...(activeTo ? { activeTo } : {}),
    areas,
    needsReview,
  };
}
