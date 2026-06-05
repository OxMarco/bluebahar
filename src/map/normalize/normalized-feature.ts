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
  sourceId?: string;
  sourceUrl?: string;
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
