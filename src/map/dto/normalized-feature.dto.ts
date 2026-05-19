export class NormalizedDetailDto {
  label!: string;
  value!: string;
}

export class NormalizedMediaDto {
  youtubeIds?: string[];
}

export class NormalizedLinkDto {
  url!: string;
  label?: string;
}

export class NormalizedRatingDto {
  value!: number;
  count!: number;
}

// Documents the `properties` object on every Feature returned for an
// interactive dataset. The geometry / type fields of the GeoJSON envelope are
// standard and not re-documented here.
export class NormalizedFeaturePropertiesDto {
  id!: string;
  title!: string;
  subtitle?: string;
  description?: string;
  tags?: string[];
  details?: NormalizedDetailDto[];
  media?: NormalizedMediaDto;
  links?: NormalizedLinkDto[];
  rating?: NormalizedRatingDto;
  sourceId?: string;
  sourceUrl?: string;
}
