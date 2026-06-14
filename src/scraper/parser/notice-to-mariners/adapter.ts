// Bridges the mariner-parser's rich GeoJSON output back onto the backend's
// existing persistence model (NoticeToMariners). One PDF maps to ONE notice
// row, whose `areas` are the plottable features flattened into the entity's
// point/line/polygon geometry parts. Circles, sectors, cliff buffers and
// coastline-closed zones all arrive here already realised as their polygon
// rings, so they map to `geometryType: 'polygon'` with no loss for rendering.
import type { FeatureCollection, Geometry, Position } from 'geojson';
import { DateTime } from 'luxon';
import { NoticeKind } from '../../notice-kind';
import type { DocumentType, NoticeExtraction } from './types';
import type { Enrichment } from './enrich';

interface NoticePoint {
  lat: number;
  long: number;
}

type NoticeGeometryType = 'point' | 'line' | 'polygon';

interface NoticeGeometryPart {
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
  // yielded no geometry despite carrying coordinates / coordinate-like text.
  // Flagged rows are persisted but hidden from public getters for human
  // curation.
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
  // When true, a 'match' verdict from the vision cross-check clears the
  // generic-extraction review flag (the vision pass is the verification a human
  // would otherwise do). Gated by VISION_AUTOCLEAR_GEOMETRY; defaults off so the
  // adapter stays conservative when the caller doesn't opt in.
  autoClearVisionMatch?: boolean;
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
  const dt = DateTime.fromISO(iso, { zone: 'utc' });
  if (!dt.isValid) return null;
  // Date-only values (YYYY-MM-DD) anchor to the start or end of that UTC day;
  // full timestamps are taken as-is.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso);
  return (dateOnly && endOfDay ? dt.endOf('day') : dt).toJSDate();
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

// Alert vs info is SEMANTIC, not geometric. An alert is an area to avoid or
// navigate with care (anchor lost, cable laid, buoy, wreck, fireworks, firing
// range, prohibited/restricted area); info is administrative or non-hazard
// navigational info (navigation lights, VHF/radio channels, harbour layout,
// amendments, cancellations). EITHER can be text-only or carry plottable areas —
// so we never infer the kind from `areas.length`. The AI enrichment triages
// exactly this (enrich.ts NoticeCategory); when it is off, failed, or undecided
// ('other'), fall back to a content-first rule: a notice is an alert if it
// carries a real hazard or restriction, OR if its document type is inherently a
// restriction/extension. The document type alone never demotes a hazard-bearing
// notice to info — that is the bug that mislabelled chart corrections.
const ALERT_DOC_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>([
  'new_restriction',
  'time_extension',
]);

function hasHazardContent(extraction: NoticeExtraction): boolean {
  return extraction.areas.some(
    (a) =>
      (Boolean(a.hazard_type) && a.hazard_type !== 'unknown') ||
      a.restrictions.some(Boolean),
  );
}

function classifyKind(
  extraction: NoticeExtraction,
  enrichment: Enrichment | null,
): NoticeKind {
  if (enrichment && enrichment.category !== 'other') {
    return enrichment.category === 'alert' ? NoticeKind.ALERT : NoticeKind.INFO;
  }
  return ALERT_DOC_TYPES.has(extraction.document_type) ||
    hasHazardContent(extraction)
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
  const possibleCoordReasons = notes.filter((n) =>
    n.startsWith('possible_coords_unparsed:'),
  );
  const genericDropReasons = notes.filter((n) =>
    n.startsWith('generic_coord_outside_malta_bbox:'),
  );
  // A vision mismatch means the notice's own chart contradicts the extracted
  // topology — exactly what the review queue exists for. Match/unverifiable/
  // failed vision notes stay informational.
  const visionReasons = notes.filter((n) => n.startsWith('vision_mismatch:'));
  const usedGenericFallback = extraction.areas.some((a) =>
    a.restrictions.some((r) => r.includes('generic extraction')),
  );
  // The generic catch-all infers multi-point geometry, so it asks a human to
  // confirm the shape matches the chart. The vision cross-check asks the model
  // that exact question; a clean 'match' is that confirmation, so when the
  // caller opts in we drop the generic flag rather than queue redundant review.
  // Only a clean match clears it — mismatch (flagged via visionReasons above),
  // unverifiable, and failed verdicts never produce a 'vision_match:' note, so
  // they keep the flag.
  const visionMatched = notes.some((n) => n.startsWith('vision_match:'));
  const genericFallbackNeedsReview =
    usedGenericFallback && !(input.autoClearVisionMatch && visionMatched);
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
    ...possibleCoordReasons,
    ...genericDropReasons,
    ...visionReasons,
    genericFallbackNeedsReview ? 'generic_extraction_verify_geometry' : null,
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
