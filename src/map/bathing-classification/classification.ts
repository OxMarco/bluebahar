// The EU Bathing Water Directive site classes plus the operational statuses the
// Environmental Health Directorate's weekly report adds (a site can be CLOSED or
// physically inaccessible, or carry too few samples to classify). Lower-case
// machine values; `classificationLabel` renders the display form. Kept in one
// place because both the importer (parsing the report) and the beaches adapter
// (merging the result onto features) need the same vocabulary, ranking and tags.
export const CLASSIFICATIONS = [
  'excellent',
  'good',
  'sufficient',
  'poor',
  'insufficient',
  'closed',
  'inaccessible',
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

// One bathing site's classification as merged onto a beach feature. `publishedOn`
// is the report's publication date (e.g. "1 June 2026") so the detail row can say
// how current the rating is.
export interface BeachClassification {
  classification: Classification;
  healthWarning: boolean;
  publishedOn?: string;
}

const LABELS: Record<Classification, string> = {
  excellent: 'Excellent',
  good: 'Good',
  sufficient: 'Sufficient',
  poor: 'Poor',
  insufficient: 'Insufficient',
  closed: 'Closed',
  inaccessible: 'Inaccessible',
};

// 4 (best) … 1 (poor) for the EU quality grades; 0 for the non-quality statuses
// (closed/inaccessible/insufficient) so the app can style them as alert/neutral
// rather than on the green→red quality ramp. Surfaced as `waterQualityRank` for
// data-driven map styling.
const RANKS: Record<Classification, number> = {
  excellent: 4,
  good: 3,
  sufficient: 2,
  poor: 1,
  insufficient: 0,
  closed: 0,
  inaccessible: 0,
};

export function classificationLabel(value: Classification): string {
  return LABELS[value];
}

export function classificationRank(value: Classification): number {
  return RANKS[value];
}

export function isClassification(value: unknown): value is Classification {
  return (
    typeof value === 'string' &&
    (CLASSIFICATIONS as readonly string[]).includes(value)
  );
}

// Normalise a free-text classification word from the report ("Excellent",
// "CLOSED", "Inaccessible", …) to a machine value, or null if unrecognised.
export function parseClassification(value: unknown): Classification | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  return isClassification(lower) ? lower : null;
}

// Site codes are printed as "A 01" / "A01" / "B 10"; canonicalise to the
// space-free upper-case form the beaches layer keys on ("A01", "B10").
export function normalizeSiteCode(value: string): string {
  return value.toUpperCase().replace(/\s+/g, '');
}

export const SITE_CODE_PATTERN = /^[A-D]\d{2}$/;

// The safety-critical / quality tags surfaced prominently on the beach detail
// sheet (and via tagsCsv for map styling). Quality grades excellent/good/
// sufficient get no tag — the dedicated water-quality detail row carries them —
// so the tag set stays reserved for things a swimmer must act on.
export function classificationTags(value: BeachClassification): string[] {
  const tags: string[] = [];
  switch (value.classification) {
    case 'closed':
      tags.push('CLOSED — bathing not recommended');
      break;
    case 'poor':
      tags.push('Poor water quality');
      break;
    case 'insufficient':
      tags.push('Insufficient water quality data');
      break;
    case 'inaccessible':
      tags.push('Inaccessible');
      break;
    default:
      break;
  }
  if (value.healthWarning) tags.push('Health warning');
  return tags;
}
