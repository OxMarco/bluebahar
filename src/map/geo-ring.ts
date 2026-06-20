// Shared GeoJSON linear-ring helpers. A ring is "closed" when its last position
// repeats the first; GeoJSON requires this, but our upstream sources (the
// notice entity's jsonb `areas`, KML zone geometry, INSPIRE feature payloads)
// routinely omit the closing seam. Kept dependency-free so the dataset catalog
// and the community-map sea filter can share it without pulling in the notice
// entity or turf.

export function isRingClosed(ring: readonly number[][]): boolean {
  if (ring.length < 2) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

export function closeRing<T extends [number, number]>(coords: T[]): T[] {
  return isRingClosed(coords) ? coords : [...coords, coords[0]];
}
