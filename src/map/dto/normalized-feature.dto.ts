import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class NormalizedDetailDto {
  @ApiProperty() label!: string;
  @ApiProperty() value!: string;
}

export class NormalizedMediaDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'YouTube video IDs (timestamps stripped).',
  })
  youtubeIds?: string[];
}

export class NormalizedLinkDto {
  @ApiProperty() url!: string;
  @ApiPropertyOptional() label?: string;
}

export class NormalizedRatingDto {
  @ApiProperty() value!: number;
  @ApiProperty({
    description: 'Number of ratings the value is aggregated from.',
  })
  count!: number;
}

// Documents the `properties` object on every Feature returned for an
// interactive dataset. The geometry / type fields of the GeoJSON envelope are
// standard and not re-documented here.
export class NormalizedFeaturePropertiesDto {
  @ApiProperty({ description: 'Stable feature identifier within the API.' })
  id!: string;

  @ApiProperty({ description: 'Human-readable name for the feature.' })
  title!: string;

  @ApiPropertyOptional({
    description: 'Short qualifier rendered under the title (e.g. site type).',
  })
  subtitle?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Short labels suitable for chips (e.g. interest categories).',
  })
  tags?: string[];

  @ApiPropertyOptional({ type: [NormalizedDetailDto] })
  details?: NormalizedDetailDto[];

  @ApiPropertyOptional({ type: NormalizedMediaDto })
  media?: NormalizedMediaDto;

  @ApiPropertyOptional({ type: [NormalizedLinkDto] })
  links?: NormalizedLinkDto[];

  @ApiPropertyOptional({ type: NormalizedRatingDto })
  rating?: NormalizedRatingDto;

  @ApiPropertyOptional({
    description: 'Identifier from the upstream dataset, when available.',
  })
  sourceId?: string;

  @ApiPropertyOptional({
    description: 'Canonical URL on the upstream source (e.g. dive site page).',
  })
  sourceUrl?: string;
}
