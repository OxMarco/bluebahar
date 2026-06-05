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
  areas: NoticeGeometryPart[];
  // True when geometry was missing/broken, a coordinate fell outside Malta, a
  // source typo was excluded, the PDF looked scanned, or a restriction notice
  // yielded no geometry despite carrying coordinates. Flagged rows are
  // persisted but hidden from public getters for human curation.
  needsReview: boolean;
  reviewReasons: string[];
}

export interface AdaptInput {
  source: string;
  extraction: NoticeExtraction;
  featureCollection: FeatureCollection<Geometry | null>;
  enrichment: Enrichment | null;
  // Strategy + enrichment notes (e.g. "coords:7", "likely_scanned_pdf:…").
  notes: string[];
  // Anchor text scraped from the listing page link (PdfLink.title). Used as a
  // human-readable title fallback when the PDF yields no title/reference.
  listingTitle?: string;
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

// A listing-page anchor title is only useful as a notice title if it's human
// text. Reject empties and URL/path fragments — Transport Malta serves PDFs via
// opaque handlers like `filestreaming.asp?fileid=11606`, and that string must
// never reach a title. (This is also why we no longer fall back to the source
// URL basename: there is no real filename to recover from such URLs.)
function usableTitle(raw: string | undefined | null): string | null {
  const t = raw?.trim();
  if (!t) return null;
  if (/^(https?:)?\/\//i.test(t) || /\.(aspx?|php|pdf|html?)\b/i.test(t)) {
    return null;
  }
  return t;
}

function parseDate(iso: string | null, endOfDay = false): Date | null {
  if (!iso) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? `${iso}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : iso;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// End of a notice's validity window — identical to the activeTo stored on the
// row (end-of-day for date-only values). Returns null when the notice never
// expires or no expiry could be extracted. Exposed so the extraction pipeline
// can discard already-lapsed notices before enrichment and storage.
export function noticeExpiry(extraction: NoticeExtraction): Date | null {
  return parseDate(extraction.valid_to, true);
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

// Alert vs info is SEMANTIC, not geometric. An alert is a hazard/restriction a
// mariner must act on; info is administrative. EITHER can be text-only or carry
// plottable areas — so we never infer the kind from `areas.length`. The AI
// enrichment already triages exactly this (enrich.ts NoticeCategory); when it is
// off, failed, or undecided ('other'), fall back to the rule-based document
// type, which itself defaults to info for anything not a restriction/extension.
const ALERT_DOC_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>([
  'new_restriction',
  'time_extension',
]);

function classifyKind(
  extraction: NoticeExtraction,
  enrichment: Enrichment | null,
): NoticeKind {
  if (enrichment && enrichment.category !== 'other') {
    return enrichment.category === 'alert' ? NoticeKind.ALERT : NoticeKind.INFO;
  }
  return ALERT_DOC_TYPES.has(extraction.document_type)
    ? NoticeKind.ALERT
    : NoticeKind.INFO;
}

function noticeCoordCount(notes: string[]): number {
  for (const n of notes) {
    const m = n.match(/^coords:(\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function uniqueReasons(reasons: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      reasons.map((r) => r?.trim()).filter((r): r is string => Boolean(r)),
    ),
  ];
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
  const activeTo = parseDate(extraction.valid_to, true) ?? undefined;

  const title =
    extraction.title ||
    usableTitle(input.listingTitle) ||
    referenceId(extraction) ||
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
  const scannedReasons = notes.filter((n) => n.includes('likely_scanned_pdf'));
  const genericDropReasons = notes.filter((n) =>
    n.startsWith('generic_coord_outside_malta_bbox:'),
  );
  const usedGenericFallback = extraction.areas.some((a) =>
    a.restrictions.some((r) => r.includes('generic extraction')),
  );
  const suspiciousEmpty =
    areas.length === 0 &&
    noticeCoordCount(notes) > 0 &&
    extraction.document_type === 'new_restriction';
  // Output invariant (defence in depth): a title must be human text, never a
  // URL/path fragment. usableTitle() already strips those from the listing
  // fallback and we no longer fall back to the source URL — but if a URL ever
  // reaches here via regex/AI extraction, flag the record for review rather than
  // publish it silently (this is the failure mode that produced the
  // "filestreaming.asp?fileid=11606" title). usableTitle returns null only for
  // empty or URL-like strings; the final title is never empty.
  const titleLooksLikeUrl = usableTitle(title) === null;
  const reviewReasons = uniqueReasons([
    ...seriousWarnings,
    ...scannedReasons,
    ...genericDropReasons,
    usedGenericFallback ? 'generic_extraction_verify_geometry' : null,
    suspiciousEmpty ? 'restriction_with_coordinates_but_no_geometry' : null,
    titleLooksLikeUrl ? 'title_looks_like_url' : null,
  ]);

  return {
    kind: classifyKind(extraction, enrichment),
    title,
    description: buildDescription(extraction, enrichment),
    source,
    subKey: '',
    ...(locationLabel ? { locationLabel } : {}),
    publishedAt,
    activeFrom,
    ...(activeTo ? { activeTo } : {}),
    ...(extraction.safety_distance_m
      ? { distance: extraction.safety_distance_m }
      : {}),
    areas,
    needsReview: reviewReasons.length > 0,
    reviewReasons,
  };
}
