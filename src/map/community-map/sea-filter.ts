// Seaward filter for community-map zones. The map mixes marine restriction
// areas with on-land ones (a no-BBQ council zone listed under "Other Areas", an
// inland stretch of a coastal layer); we only want the marine ones.
//
// A zone is kept iff its geometry intersects the SEA — the Maltese-waters
// contour minus the island landmass. This keeps fully-offshore zones AND coastal
// zones that straddle the shoreline (they touch the water), and drops only zones
// lying entirely on land. The coastline and national-waters polygons are local
// assets, so the filter needs no additional network call.
import { booleanIntersects } from '@turf/boolean-intersects';
import { difference } from '@turf/difference';
import {
  featureCollection,
  lineString,
  multiPolygon,
  point,
  polygon,
} from '@turf/helpers';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { landPolygons, malteseWatersPolygons } from './polygon-data';
import type { ZoneGeometry } from './kml-source';
import { closeRing } from '../geo-ring';

// undefined = not computed, null = could not compute (files missing) -> fail
// open so a missing data file disables the filter rather than dropping every
// zone (mirrors coastline.ts's fail-open posture for the same files).
let cachedSea: Feature<Polygon | MultiPolygon> | null | undefined;

function seaArea(): Feature<Polygon | MultiPolygon> | null {
  if (cachedSea !== undefined) return cachedSea;
  const waters = malteseWatersPolygons();
  const land = landPolygons();
  if (waters.length === 0) {
    console.warn(
      'community-map sea-filter: Maltese-waters polygons missing — filter disabled',
    );
    cachedSea = null;
    return null;
  }
  try {
    const watersFeat = multiPolygon(waters);
    // No land file: the whole waters area counts as sea (still drops far-inland
    // zones that fall outside the contour entirely).
    if (land.length === 0) {
      cachedSea = watersFeat;
      return cachedSea;
    }
    cachedSea = difference(featureCollection([watersFeat, multiPolygon(land)]));
  } catch (err) {
    console.warn(
      `community-map sea-filter: failed to build sea polygon — filter disabled: ${String(err)}`,
    );
    cachedSea = null;
  }
  return cachedSea ?? null;
}

function toFeature(geom: ZoneGeometry): Feature | null {
  try {
    if (geom.type === 'point') return point(geom.points[0]);
    if (geom.type === 'line' && geom.points.length >= 2)
      return lineString(geom.points);
    if (geom.type === 'polygon' && geom.points.length >= 3)
      return polygon([closeRing(geom.points)]);
  } catch {
    return null;
  }
  return null;
}

// True if the shape touches the sea (or the filter is disabled). A degenerate
// shape that can't be built into a feature is treated as non-marine.
export function isMarineGeometry(geom: ZoneGeometry): boolean {
  const sea = seaArea();
  if (!sea) return true; // fail open
  const feat = toFeature(geom);
  if (!feat) return false;
  try {
    return booleanIntersects(feat, sea);
  } catch {
    return false;
  }
}

// Keep only the sea-touching shapes of a zone. A zone whose every shape is
// on land yields [] and is dropped by the caller.
export function filterMarineGeometries(geoms: ZoneGeometry[]): ZoneGeometry[] {
  return geoms.filter(isMarineGeometry);
}

// Test seam: reset the memoized sea polygon (e.g. after pointing COASTLINE_FILE
// / MALTESE_WATERS_FILE at a fixture).
export function _resetSeaCache(): void {
  cachedSea = undefined;
}
