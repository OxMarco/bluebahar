import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { DatasetKind } from '../datasets';

export class DatasetDto {
  @ApiProperty({ description: 'Stable identifier used in dataset URLs.' })
  key!: string;

  @ApiProperty({ description: 'Human-readable name.' })
  name!: string;

  @ApiProperty({
    description:
      "How clients should treat features in this layer. 'interactive' = features carry user-facing metadata and should be tappable to open a detail sheet. 'context' = geometry-only overlay, render as passive background.",
    enum: ['interactive', 'context'],
  })
  kind!: DatasetKind;

  @ApiProperty({
    description: 'Original source URL the GeoJSON was derived from.',
  })
  sourceUrl!: string;

  @ApiProperty({ description: 'Number of features in the FeatureCollection.' })
  featureCount!: number;

  @ApiProperty({
    type: [String],
    description: 'GeoJSON geometry types present in this dataset.',
  })
  geometryTypes!: string[];

  @ApiPropertyOptional({
    type: [Number],
    description: 'Dataset extent as [minLng, minLat, maxLng, maxLat].',
  })
  bbox?: [number, number, number, number];

  @ApiProperty({
    description:
      'Size of the served GeoJSON payload in bytes (post-normalization for interactive layers).',
  })
  byteSize!: number;

  @ApiProperty({
    description:
      'SHA-256 hex digest of the served payload; matches the ETag returned by GET /map/datasets/:key.',
  })
  sha256!: string;
}
