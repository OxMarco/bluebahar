import { distance } from '@turf/distance';
import { lineString, pointOnFeature, polygon } from '@turf/turf';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';

type EntityPart = NoticeToMariners['areas'][number];
type GeoCoordinate = { latitude: number; longitude: number };
type GeoBoundingCircle = { center: GeoCoordinate; radiusMetres: number };

function isFinitePoint(p: { lat: number; long: number }): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.long);
}

function distanceMetres(a: GeoCoordinate, b: GeoCoordinate): number {
  return distance([a.longitude, a.latitude], [b.longitude, b.latitude], {
    units: 'meters',
  });
}

// Centred anchor for one geometry part. A point hazard anchors on itself; a
// line on a point along it; a polygon on a point *inside* it (turf's
// pointOnFeature guarantees containment even for concave rings — e.g. a firing
// range), so the pin sits on the area rather than on an arbitrary corner
// vertex. Falls back to the first finite vertex when there aren't enough points
// to form the shape (or turf rejects it), so a usable part never yields null.
function anchorForPart(part: EntityPart): GeoCoordinate | null {
  const finite = part.points.filter(isFinitePoint);
  if (finite.length === 0) return null;

  const first: GeoCoordinate = {
    latitude: finite[0].lat,
    longitude: finite[0].long,
  };
  const coords = finite.map((p) => [p.long, p.lat] as [number, number]);

  try {
    if (part.geometryType === 'line' && coords.length >= 2) {
      const [lon, lat] = pointOnFeature(lineString(coords)).geometry
        .coordinates;
      return { latitude: lat, longitude: lon };
    }
    if (part.geometryType === 'polygon' && coords.length >= 3) {
      // GeoJSON rings must be closed; close the seam when the source omits it.
      const a = coords[0];
      const b = coords[coords.length - 1];
      const ring = a[0] === b[0] && a[1] === b[1] ? coords : [...coords, a];
      const [lon, lat] = pointOnFeature(polygon([ring])).geometry.coordinates;
      return { latitude: lat, longitude: lon };
    }
  } catch {
    // Degenerate ring/line (collinear, self-touching) — fall through to the
    // first vertex rather than dropping the pin entirely.
  }
  return first;
}

// Anchor used as the pin and the "near here" reference point on the client.
// Takes the first part that yields a usable point — preserving the historical
// first-part bias — but anchors *within* that part's shape (see anchorForPart)
// instead of grabbing its first raw vertex. Returns null only when a notice has
// no usable geometry — the same case the serializer maps to `geometry: null`.
export function representativePoint(
  entity: NoticeToMariners,
): GeoCoordinate | null {
  for (const part of entity.areas) {
    const anchor = anchorForPart(part);
    if (anchor) return anchor;
  }
  return null;
}

// Smallest axis-aligned bounding circle around every coordinate in the notice,
// expanded by `distance` (safety berth) when at least one part is point-shaped.
// Pre-computed here so the client doesn't traverse geometries to set up
// geofences or "is the user near this notice" checks.
export function boundingCircle(
  entity: NoticeToMariners,
): GeoBoundingCircle | null {
  const points: { lat: number; long: number }[] = [];
  let hasPointPart = false;
  for (const part of entity.areas) {
    if (part.geometryType === 'point') hasPointPart = true;
    for (const p of part.points) {
      if (isFinitePoint(p)) points.push(p);
    }
  }
  if (points.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLong = Infinity;
  let maxLong = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.long < minLong) minLong = p.long;
    if (p.long > maxLong) maxLong = p.long;
  }
  const center: GeoCoordinate = {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLong + maxLong) / 2,
  };

  let radiusMetres = 0;
  for (const p of points) {
    const d = distanceMetres(center, { latitude: p.lat, longitude: p.long });
    if (d > radiusMetres) radiusMetres = d;
  }

  // `distance` is the safety berth from a point hazard; only meaningful when
  // at least one part is point-shaped. For pure polygon/line notices the
  // geometry itself already describes the affected area.
  if (hasPointPart && entity.distance != null && entity.distance > 0) {
    radiusMetres += entity.distance;
  }

  return { center, radiusMetres };
}
