// Shape that interactive datasets present to the client. Each upstream source
// (maltadives, INSPIRE GML, etc.) has its own property schema; the adapters
// in ./adapters.ts collapse them into this single shape so the client renders
// one detail sheet for everything.
export interface NormalizedFeatureProperties {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  tags?: string[];
  details?: NormalizedDetail[];
  media?: NormalizedMedia;
  links?: NormalizedLink[];
  rating?: NormalizedRating;
  waterQuality?: NormalizedWaterQuality;
  sourceId?: string;
  sourceUrl?: string;
}

// EU Bathing Water Directive classification merged onto a beach feature.
// `value` is the machine class (excellent…inaccessible), `label` its display
// form, `rank` a 0–4 quality score (0 for non-quality statuses) for styling.
export interface NormalizedWaterQuality {
  value: string;
  label: string;
  rank: number;
  healthWarning?: boolean;
}

interface NormalizedDetail {
  label: string;
  value: string;
}

interface NormalizedMedia {
  youtubeIds?: string[];
}

export interface NormalizedLink {
  url: string;
  label?: string;
}

interface NormalizedRating {
  value: number;
  count: number;
}
