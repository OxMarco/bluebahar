// Great-circle distance helper, vendored from the mariner-parser project.
import { distance as turfDistance } from '@turf/distance';

export type LatLon = { lat: number; lon: number };

export function distanceKm(a: LatLon, b: LatLon): number {
  return turfDistance([a.lon, a.lat], [b.lon, b.lat], { units: 'kilometers' });
}
