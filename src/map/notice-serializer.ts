import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import {
  NoticeDto,
  NoticeGeometry,
  NoticeFeature,
  NoticeFeatureCollection,
  GeoJsonPoint,
  GeoJsonLineString,
  GeoJsonPolygon,
} from './dto/notice.dto';
import {
  boundingCircle,
  isFinitePoint,
  representativePoints,
} from './notice-geometry';
import { closeRing } from './geo-ring';

type EntityGeometryPart = NoticeToMariners['areas'][number];

function pointToCoord(p: { lat: number; long: number }): [number, number] {
  return [p.long, p.lat];
}

function partToGeometry(part: EntityGeometryPart): NoticeGeometry | null {
  // Drop non-finite coordinates before the per-type length checks, mirroring
  // notice-geometry's anchor logic — one NaN/null vertex would otherwise emit
  // GeoJSON that Mapbox GL rejects, blanking the whole source.
  const coords = part.points.filter(isFinitePoint).map(pointToCoord);
  if (coords.length === 0) return null;

  switch (part.geometryType) {
    case 'point':
      return { type: 'Point', coordinates: coords[0] } satisfies GeoJsonPoint;

    case 'line':
      return coords.length >= 2
        ? ({
            type: 'LineString',
            coordinates: coords,
          } satisfies GeoJsonLineString)
        : null;

    case 'polygon': {
      // GeoJSON polygons require closed linear rings (first === last) with
      // at least 4 positions. Auto-close when the source omits the seam.
      const ring = closeRing(coords);
      if (ring.length < 4) return null;
      return {
        type: 'Polygon',
        coordinates: [ring],
      } satisfies GeoJsonPolygon;
    }
  }
}

function partToFeature(
  part: EntityGeometryPart,
  index: number,
  noticeId: string,
): NoticeFeature | null {
  const geometry = partToGeometry(part);
  if (geometry === null) return null;
  return {
    type: 'Feature',
    geometry,
    properties: { noticeId, part: index, kind: part.geometryType },
  };
}

// Every drawable part becomes its own GeoJSON Feature. Mapbox GL — and so
// rnmapbox/maps on the app — won't render a GeometryCollection inside a
// ShapeSource, so a multi-part notice (a cable plus a wreck, two firing ranges)
// must ship as a FeatureCollection. Single-part notices use the same shape so
// the client always feeds one type to its ShapeSource. `null` when no part
// yields valid GeoJSON, mirroring the empty-geometry case the client guards on.
function buildFeatureCollection(
  entity: NoticeToMariners,
): NoticeFeatureCollection | null {
  const features = entity.areas
    .map((part, index) => partToFeature(part, index, entity.id))
    .filter((feature): feature is NoticeFeature => feature !== null);
  if (features.length === 0) return null;
  return { type: 'FeatureCollection', features };
}

export function toNoticeDto(entity: NoticeToMariners): NoticeDto {
  const anchors = representativePoints(entity);

  return {
    id: entity.id,
    kind: entity.kind,
    title: entity.title,
    description: entity.description,
    source: entity.source,
    locationLabel: entity.locationLabel ?? null,
    activeFrom: entity.activeFrom.toISOString(),
    activeTo: entity.activeTo ? entity.activeTo.toISOString() : null,
    distance: entity.distance ?? null,
    reviewReasons: entity.reviewReasons ?? [],
    geometry: buildFeatureCollection(entity),
    representativePoint: anchors[0] ?? null,
    representativePoints: anchors,
    boundingCircle: boundingCircle(entity),
  };
}
