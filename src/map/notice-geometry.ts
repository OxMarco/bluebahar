import { distance } from '@turf/distance';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';

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

// First valid coordinate across all parts. Used as the pin anchor and the
// "near here" reference point on the client. Returns null only when a notice
// has no usable geometry — same case the serializer maps to `geometry: null`.
export function representativePoint(
  entity: NoticeToMariners,
): GeoCoordinate | null {
  for (const part of entity.areas) {
    for (const p of part.points) {
      if (isFinitePoint(p)) return { latitude: p.lat, longitude: p.long };
    }
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
