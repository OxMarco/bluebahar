import { ApiProperty } from '@nestjs/swagger';

export class DatasetDto {
  @ApiProperty({ description: 'Stable identifier used in dataset URLs.' })
  key!: string;

  @ApiProperty({ description: 'Human-readable name.' })
  name!: string;

  @ApiProperty({
    description: 'Original WFS endpoint the GeoJSON was downloaded from.',
  })
  sourceUrl!: string;

  @ApiProperty({ description: 'Number of features in the FeatureCollection.' })
  featureCount!: number;

  @ApiProperty({ description: 'Size of the GeoJSON file on disk, in bytes.' })
  byteSize!: number;

  @ApiProperty({ description: 'SHA-256 hex digest of the GeoJSON file.' })
  sha256!: string;
}
