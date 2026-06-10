// Build plottable GeoJSON from a normalized NoticeExtraction. Vendored from the
// mariner-parser project (bench/geometry.ts).
//
// Geometry rule (hazard-driven, per domain guidance):
//   submarine_power_cable / linestring  -> LineString (the cable limit, NOT an area)
//   circle                              -> Polygon (turf circle around the centre)
//   cliff_buffer                        -> buffer off the coastline, clipped to the sea
//   polygon_coastline                   -> Polygon, closed via coastline (or straight-line fallback)
//   polygon                             -> Polygon from the points as-is
//   point                               -> Point
import { circle as turfCircle } from '@turf/circle';
import { buffer as turfBuffer } from '@turf/buffer';
import { difference as turfDifference } from '@turf/difference';
import { sector as turfSector } from '@turf/sector';
import { bearing as turfBearing } from '@turf/bearing';
import { booleanIntersects } from '@turf/boolean-intersects';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { booleanWithin } from '@turf/boolean-within';
import { rewind as turfRewind } from '@turf/rewind';
import {
  lineString as turfLine,
  polygon as turfPolygon,
  feature as turfFeature,
  featureCollection as turfFC,
} from '@turf/helpers';
import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
} from 'geojson';
import type { Area, NoticeExtraction, ResolvedPoint } from './types';
import {
  closeRing,
  coastlineArc,
  landPolygons,
  malteseWatersPolygons,
  type LngLat,
} from './coastline';
import { inBbox } from './core';
import { distanceKm } from './spatial';

// Flag points that are gross spatial outliers from the rest of the area's
// cluster — almost always a transcription typo in the source PDF (e.g. a
// latitude minute read as 59 instead of 00, throwing one vertex ~110 km away).
// Returns index -> distance (km) to the nearest other point. Needs ≥4 points so
// the surviving cluster stays meaningful.
function clusterOutliers(pts: ResolvedPoint[]): Map<number, number> {
  const out = new Map<number, number>();
  if (pts.length < 4) return out;
  const nn = pts.map((p, i) =>
    Math.min(...pts.flatMap((q, j) => (j === i ? [] : [distanceKm(p, q)]))),
  );
  const sorted = [...nn].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  pts.forEach((_, i) => {
    if (nn[i] > Math.max(30, median * 8)) out.set(i, nn[i]);
  });
  return out;
}

// Clip a buffered-shore strip to the seaward side by subtracting the island
// land it straddles. Returns the strip unchanged if no land is available or the
// subtraction empties it.
function seawardOnly(
  strip: Feature<Polygon | MultiPolygon>,
): Feature<Polygon | MultiPolygon> {
  let out: Feature<Polygon | MultiPolygon> = strip;
  for (const rings of landPolygons()) {
    const land = turfPolygon(rings);
    if (!booleanIntersects(out, land)) continue;
    const diff = turfDifference(turfFC([out, land]));
    if (diff) out = diff;
  }
  return out;
}

type SimpleGeometry = Exclude<Geometry, { type: 'GeometryCollection' }>;

function simpleGeometries(geometry: Geometry): SimpleGeometry[] {
  if (geometry.type !== 'GeometryCollection') return [geometry];
  return geometry.geometries.flatMap(simpleGeometries);
}

function pointWithinPolygon(point: Point, polygon: Feature<Polygon>): boolean {
  return booleanPointInPolygon(turfFeature(point), polygon);
}

function geometryWithinPolygon(
  geometry: SimpleGeometry,
  polygon: Feature<Polygon>,
): boolean {
  try {
    return geometry.type === 'Point'
      ? pointWithinPolygon(geometry, polygon)
      : booleanWithin(turfFeature(geometry), polygon);
  } catch {
    return false;
  }
}

function geometryEntirelyOnLand(geometry: Geometry): boolean {
  const land = landPolygons().map((rings) => turfPolygon(rings));
  if (land.length === 0) return false;
  const parts = simpleGeometries(geometry);
  return parts.every((part) =>
    land.some((polygon) => geometryWithinPolygon(part, polygon)),
  );
}

function geometryInsideMalteseWaters(geometry: Geometry): boolean {
  const waters = malteseWatersPolygons().map((rings) => turfPolygon(rings));
  if (waters.length === 0) return true;
  const parts = simpleGeometries(geometry);
  return parts.every((part) =>
    waters.some((polygon) => geometryWithinPolygon(part, polygon)),
  );
}

type BuiltFeature = Feature<Geometry | null> & {
  properties: Record<string, unknown>;
};

function buildAreaFeature(area: Area, notice: NoticeExtraction): BuiltFeature {
  const warnings: string[] = [];
  // Exclude gross outliers (likely typos) from the plotted geometry, but keep them named.
  const outliers = clusterOutliers(area.points);
  for (const [i, dist] of outliers)
    warnings.push(
      `outlier_point_excluded:${area.points[i].label} (~${Math.round(dist)} km from the others — likely a transcription error in the source)`,
    );
  const usable = area.points.filter((_, i) => !outliers.has(i));
  const coords: LngLat[] = usable.map((p) => [p.lon, p.lat] as LngLat);
  for (let i = 0; i < area.points.length; i++)
    if (!outliers.has(i) && !inBbox(area.points[i]))
      warnings.push(`point_outside_malta_bbox:${area.points[i].label}`);

  let geometry: Geometry | null = null;

  switch (area.geometry_kind) {
    case 'circle': {
      if (area.points.length && area.radius_nm) {
        const c = area.points[0];
        geometry = turfCircle([c.lon, c.lat], area.radius_nm, {
          steps: 96,
          units: 'nauticalmiles',
        }).geometry;
      } else warnings.push('circle_missing_center_or_radius');
      break;
    }
    case 'sector': {
      // Wedge from the centre (points[0]) bounded by the radii to the rim
      // points. Use the minor arc the rim points span, then clip to the sea.
      if (area.points.length >= 3 && area.radius_nm) {
        const c: [number, number] = [area.points[0].lon, area.points[0].lat];
        const rim = area.points
          .slice(1)
          .map((p) => [p.lon, p.lat] as [number, number]);
        const norm = (b: number) => (b + 360) % 360;
        let b1 = norm(turfBearing(c, rim[0]));
        let b2 = norm(turfBearing(c, rim[rim.length - 1]));
        if ((b2 - b1 + 360) % 360 > 180) [b1, b2] = [b2, b1]; // keep the minor arc
        const wedge = turfSector(c, area.radius_nm, b1, b2, {
          units: 'nauticalmiles',
          steps: 96,
        });
        geometry = seawardOnly(wedge).geometry;
      } else warnings.push('sector_needs_center_and_two_rim_points');
      break;
    }
    case 'linestring': {
      if (coords.length >= 2)
        geometry = { type: 'LineString', coordinates: coords };
      else warnings.push('linestring_too_few_points');
      break;
    }
    case 'polygon': {
      if (coords.length >= 3) {
        const ring = [...coords, coords[0]];
        geometry = { type: 'Polygon', coordinates: [ring] };
      } else warnings.push('polygon_too_few_points');
      break;
    }
    case 'polygon_coastline': {
      if (coords.length >= 2) {
        const { ring, usedCoastline, note } = closeRing(coords);
        if (!usedCoastline) warnings.push(`coastline_closure_fallback:${note}`);
        geometry =
          ring.length >= 4
            ? { type: 'Polygon', coordinates: [ring] }
            : { type: 'LineString', coordinates: coords };
        if (ring.length < 4)
          warnings.push('polygon_coastline_degenerate_to_line');
      } else warnings.push('polygon_coastline_too_few_points');
      break;
    }
    case 'cliff_buffer': {
      // "Maintain N m from the cliff" = a strip wrapping the cliff line. The
      // cliff has no coordinates of its own, so anchor it to the sibling zone in
      // the same section and buffer the coastline arc between their ends.
      const buf = area.buffer_m;
      const sibling = notice.areas.find(
        (a) => a !== area && a.name === area.name && a.points.length >= 2,
      );
      const endpoints = (sibling ?? area).points;
      if (buf && endpoints.length >= 2) {
        const from: LngLat = [endpoints[0].lon, endpoints[0].lat];
        const to: LngLat = [
          endpoints[endpoints.length - 1].lon,
          endpoints[endpoints.length - 1].lat,
        ];
        const arc = coastlineArc(from, to);
        if (arc && arc.length >= 2) {
          const strip = turfBuffer(turfLine(arc), buf, { units: 'meters' });
          if (strip) geometry = seawardOnly(strip).geometry;
        }
      }
      if (!geometry) {
        warnings.push(`cliff_buffer_requires_coastline:${buf ?? '?'}m`);
      }
      break;
    }
    case 'point': {
      if (area.points.length) {
        const c = area.points[0];
        geometry = { type: 'Point', coordinates: [c.lon, c.lat] };
      } else warnings.push('point_missing');
      break;
    }
    case 'none':
    default:
      break;
  }

  // Normalise polygon winding to the RFC 7946 right-hand rule so downstream
  // consumers that respect winding render the fill correctly.
  if (
    geometry &&
    (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
  ) {
    geometry = turfRewind(geometry, {
      reverse: false,
    }) as Geometry;
  }

  if (geometry) {
    if (geometryEntirelyOnLand(geometry)) {
      warnings.push(`geometry_entirely_on_land:${area.area_id}`);
    }
    if (!geometryInsideMalteseWaters(geometry)) {
      warnings.push(`geometry_outside_maltese_waters:${area.area_id}`);
    }
  }

  return {
    type: 'Feature',
    geometry,
    properties: {
      area_id: area.area_id,
      notice:
        notice.notice_no && notice.notice_year
          ? `${notice.notice_no}/${notice.notice_year}`
          : null,
      name: area.name,
      chart: area.chart,
      zone_color: area.zone_color,
      hazard_type: area.hazard_type,
      operation: area.operation,
      geometry_kind: area.geometry_kind,
      radius_nm: area.radius_nm,
      buffer_m: area.buffer_m,
      point_labels: area.point_labels,
      restrictions: area.restrictions,
      warnings,
    },
  };
}

// Sibling zones from one notice (Mellieha's mooring zones A..N, separated by
// fairways) must not overlap; a vertex of one zone landing inside another is
// the signature of a transcription typo in the source table that is far too
// small for the gross-outlier guard to see. Only plain point-list polygons are
// checked: circles/sectors legitimately overlap corridors, and coastline-
// closed rings follow the shore wherever it goes.
function flagOverlappingSiblings(
  notice: NoticeExtraction,
  features: BuiltFeature[],
): void {
  const polys = features
    .map((f, i) => ({ f, area: notice.areas[i] }))
    .filter(
      ({ f, area }) =>
        area.geometry_kind === 'polygon' && f.geometry?.type === 'Polygon',
    );
  for (const a of polys) {
    for (const b of polys) {
      if (a === b) continue;
      const ring = (a.f.geometry as Polygon).coordinates[0];
      // ignoreBoundary: sibling zones legitimately share corner vertices and
      // edges; only a vertex strictly INSIDE the other zone is suspicious.
      const hit = b.area.points.some((p) =>
        booleanPointInPolygon([p.lon, p.lat], turfPolygon([ring]), {
          ignoreBoundary: true,
        }),
      );
      if (hit) {
        const w = a.f.properties.warnings as string[];
        w.push(
          `overlaps_sibling_area:${a.area.area_id}~${b.area.area_id} (a vertex of one zone falls inside the other — possible transcription error)`,
        );
      }
    }
  }
}

export function buildFeatureCollection(
  notice: NoticeExtraction,
): FeatureCollection<Geometry | null> {
  const features = notice.areas.map((a) => buildAreaFeature(a, notice));
  flagOverlappingSiblings(notice, features);
  return {
    type: 'FeatureCollection',
    features,
  };
}
