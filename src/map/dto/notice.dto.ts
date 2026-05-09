import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoticeKind } from '../../scraper/notice-kind';

// Minimal GeoJSON shapes the backend emits. Coordinates follow the spec's
// [longitude, latitude] order — note the swap from the entity's {lat, long}.
export type GeoJsonPoint = { type: 'Point'; coordinates: [number, number] };
export type GeoJsonLineString = {
  type: 'LineString';
  coordinates: [number, number][];
};
export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: [number, number][][];
};
export type GeoJsonGeometryCollection = {
  type: 'GeometryCollection';
  geometries: NoticeGeometry[];
};
export type NoticeGeometry =
  | GeoJsonPoint
  | GeoJsonLineString
  | GeoJsonPolygon
  | GeoJsonGeometryCollection;

export class NoticeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: NoticeKind })
  kind!: NoticeKind;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  source!: string;

  @ApiPropertyOptional({ nullable: true })
  locationLabel?: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  activeFrom!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  activeTo?: string | null;

  @ApiPropertyOptional({
    description:
      'Safety berth radius in metres. Only meaningful for point-shaped hazards.',
    nullable: true,
  })
  distance?: number | null;

  @ApiPropertyOptional({
    description:
      'GeoJSON geometry for the notice. Single Point/LineString/Polygon when there is one part; GeometryCollection when several. Null for advisories without a location.',
    nullable: true,
  })
  geometry!: NoticeGeometry | null;
}
