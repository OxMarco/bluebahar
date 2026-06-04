import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
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
  representativePoint,
  representativePoints,
} from './notice-geometry';

type EntityGeometryPart = NoticeToMariners['areas'][number];

function pointToCoord(p: { lat: number; long: number }): [number, number] {
  return [p.long, p.lat];
}

function partToGeometry(part: EntityGeometryPart): NoticeGeometry | null {
  if (part.points.length === 0) return null;
  const coords = part.points.map(pointToCoord);

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
      const ring = isRingClosed(coords) ? coords : [...coords, coords[0]];
      if (ring.length < 4) return null;
      return {
        type: 'Polygon',
        coordinates: [ring],
      } satisfies GeoJsonPolygon;
    }
  }
}

function isRingClosed(coords: [number, number][]): boolean {
  if (coords.length < 2) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  return a[0] === b[0] && a[1] === b[1];
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
    representativePoint: representativePoint(entity),
    representativePoints: representativePoints(entity),
    boundingCircle: boundingCircle(entity),
  };
}
