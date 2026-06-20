import { NoticeKind } from '../notice-kind';

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
// One drawable area part of a notice. Always a simple geometry — never a
// GeometryCollection, which Mapbox GL (and thus rnmapbox/maps) refuses to
// render inside a ShapeSource.
export type NoticeGeometry = GeoJsonPoint | GeoJsonLineString | GeoJsonPolygon;

type NoticeGeometryKind = 'point' | 'line' | 'polygon';

export type NoticeFeature = {
  type: 'Feature';
  geometry: NoticeGeometry;
  properties: {
    // The owning notice, so a tapped feature resolves back to its NoticeDto.
    noticeId: string;
    // Index of this part within the notice's source `areas`.
    part: number;
    // Lets the client route the part to the right Fill/Line/Circle layer.
    kind: NoticeGeometryKind;
  };
};

// A notice's geometry ships as a GeoJSON FeatureCollection — one Feature per
// area part — so the client can hand it straight to a rnmapbox/Mapbox
// ShapeSource (which accepts a Feature/FeatureCollection, not a bare geometry)
// and so mixed point/line/polygon parts coexist without a GeometryCollection.
export type NoticeFeatureCollection = {
  type: 'FeatureCollection';
  features: NoticeFeature[];
};

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
  geometry!: NoticeFeatureCollection | null;
  // Single anchor (first area part) — used for the "near here" reference.
  representativePoint!: GeoCoordinateDto | null;
  // One anchor per drawable area part, so every shape the client renders for a
  // multi-part notice gets its own tappable pin. Empty when no usable geometry.
  representativePoints!: GeoCoordinateDto[];
  boundingCircle!: BoundingCircleDto | null;
}
