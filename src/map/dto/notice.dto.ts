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

export class GeoCoordinateDto {
  latitude!: number;
  longitude!: number;
}

export class BoundingCircleDto {
  center!: GeoCoordinateDto;
  radiusMetres!: number;
}

export class NoticeDto {
  id!: string;
  kind!: NoticeKind;
  title!: string;
  description!: string;
  source!: string;
  locationLabel?: string | null;
  activeFrom!: string;
  activeTo?: string | null;
  distance?: number | null;
  reviewReasons?: string[];
  geometry!: NoticeGeometry | null;
  // Single anchor (first area part) — used for the "near here" reference.
  representativePoint!: GeoCoordinateDto | null;
  // One anchor per drawable area part, so every shape the client renders for a
  // multi-part notice gets its own tappable pin. Empty when no usable geometry.
  representativePoints!: GeoCoordinateDto[];
  boundingCircle!: BoundingCircleDto | null;
}
