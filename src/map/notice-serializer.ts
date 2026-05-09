import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import {
  NoticeDto,
  NoticeGeometry,
  GeoJsonPoint,
  GeoJsonLineString,
  GeoJsonPolygon,
} from './dto/notice.dto';

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

function buildGeometry(parts: EntityGeometryPart[]): NoticeGeometry | null {
  const built = parts
    .map(partToGeometry)
    .filter((g): g is NoticeGeometry => g !== null);
  if (built.length === 0) return null;
  if (built.length === 1) return built[0];
  return { type: 'GeometryCollection', geometries: built };
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
    geometry: buildGeometry(entity.areas),
  };
}
