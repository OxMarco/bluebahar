// Local coastline loader + open-polygon closure, vendored from the
// mariner-parser project (bench/coastline.ts).
//
// Closure problem: many zones are described as an open sequence of "imaginary
// lines" (e.g. 1A->1B->...->1E) meant to be closed by "the intermediate
// coastline" running between the two open ends. To realise a true polygon we
// walk the coastline between those ends and stitch it onto the sequence.
//
// Data source is a LOCAL file only (no network):
// data/malta-coastline.geojson (override with COASTLINE_FILE). If the file is
// absent, closeRing() falls back to a straight line and reports
// `usedCoastline:false` so callers can warn.

import fs from 'node:fs';
import path from 'node:path';
import { distance as turfDistance } from '@turf/turf';
import type { GeoJSON, Geometry, Position } from 'geojson';

// Vendored, high-resolution island coastline (Malta, Gozo, Comino, Cominotto,
// St Paul's, + rocks; OSM-derived, committed as a static asset). Override with
// COASTLINE_FILE. nest-cli copies the .geojson asset alongside the compiled JS,
// so __dirname/data resolves both under ts-jest (src) and the built dist tree.
const DATA_DIR = path.join(__dirname, 'data');
const COASTLINE = path.join(DATA_DIR, 'malta-coastline.geojson');
const WATERS = path.join(DATA_DIR, 'maltese-waters-contour.geojson');
const DEFAULT_FILE = fs.existsSync(COASTLINE) ? COASTLINE : WATERS;
const DEFAULT_WATERS_FILE = path.resolve(
  process.cwd(),
  'data/datasets/maltese-waters-contour.geojson',
);

export type LngLat = [number, number]; // [lon, lat]

let cachedSegments: LngLat[][] | null | undefined; // undefined = not loaded, null = file missing

const toLngLat = (p: Position): LngLat => [p[0], p[1]];
const toRing = (ring: Position[]): LngLat[] => ring.map(toLngLat);

// Flatten a parsed GeoJSON document into its concrete (non-collection)
// geometries, descending through FeatureCollection / Feature / GeometryCollection.
function readGeometries(file: string): Geometry[] {
  const gj = JSON.parse(fs.readFileSync(file, 'utf8')) as GeoJSON;
  const out: Geometry[] = [];
  const walk = (node: GeoJSON | Geometry | null): void => {
    if (!node) return;
    switch (node.type) {
      case 'FeatureCollection':
        node.features.forEach((f) => walk(f.geometry));
        break;
      case 'Feature':
        walk(node.geometry);
        break;
      case 'GeometryCollection':
        node.geometries.forEach(walk);
        break;
      default:
        out.push(node);
        break;
    }
  };
  walk(gj);
  return out;
}

function polygonRingsFrom(file: string): LngLat[][][] {
  const polys: LngLat[][][] = [];
  for (const g of readGeometries(file)) {
    if (g.type === 'Polygon') polys.push(g.coordinates.map(toRing));
    else if (g.type === 'MultiPolygon')
      g.coordinates.forEach((poly) => polys.push(poly.map(toRing)));
  }
  return polys;
}

// Memoized polygon-ring loader: resolves a file lazily (so env overrides apply),
// caches the parsed rings, and caches the file-missing case as [] too.
function makePolygonLoader(resolveFile: () => string): () => LngLat[][][] {
  let cache: LngLat[][][] | null | undefined;
  return () => {
    if (cache !== undefined) return cache ?? [];
    const file = resolveFile();
    cache = fs.existsSync(file) ? polygonRingsFrom(file) : null;
    return cache ?? [];
  };
}

// The closed island polygons from the coastline file (each is a Polygon's ring
// set: [outer, ...holes]). Used to clip a cliff buffer to the seaward side.
export const landPolygons = makePolygonLoader(
  () => process.env.COASTLINE_FILE || DEFAULT_FILE,
);

// The Maltese national-waters contour rings.
export const malteseWatersPolygons = makePolygonLoader(
  () => process.env.MALTESE_WATERS_FILE || DEFAULT_WATERS_FILE,
);

function loadCoastlineSegments(): LngLat[][] | null {
  if (cachedSegments !== undefined) return cachedSegments;
  const file = process.env.COASTLINE_FILE || DEFAULT_FILE;
  if (!fs.existsSync(file)) {
    cachedSegments = null;
    return null;
  }
  const segments: LngLat[][] = [];
  const pushLine = (coords: LngLat[]) => {
    if (coords.length >= 2) segments.push(coords);
  };
  for (const g of readGeometries(file)) {
    switch (g.type) {
      case 'LineString':
        pushLine(toRing(g.coordinates));
        break;
      case 'MultiLineString':
        g.coordinates.forEach((line) => pushLine(toRing(line)));
        break;
      case 'Polygon':
        g.coordinates.forEach((ring) => pushLine(toRing(ring))); // each ring
        break;
      case 'MultiPolygon':
        g.coordinates.forEach((poly) =>
          poly.forEach((ring) => pushLine(toRing(ring))),
        );
        break;
    }
  }
  cachedSegments = segments;
  return segments;
}

function dist(a: LngLat, b: LngLat): number {
  return turfDistance(a, b, { units: 'kilometers' });
}

// Connectivity graph over coastline vertices, keyed by rounded coordinate so
// shared nodes between ways join up.
type Graph = {
  nodes: LngLat[];
  adj: Map<number, Set<number>>;
  index: Map<string, number>;
};
let cachedGraph: Graph | null | undefined;

function key(c: LngLat): string {
  return `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
}

function buildGraph(): Graph | null {
  if (cachedGraph !== undefined) return cachedGraph;
  const segments = loadCoastlineSegments();
  if (!segments) {
    cachedGraph = null;
    return null;
  }
  const nodes: LngLat[] = [];
  const index = new Map<string, number>();
  const adj = new Map<number, Set<number>>();
  const idOf = (c: LngLat): number => {
    const k = key(c);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push(c);
      index.set(k, id);
      adj.set(id, new Set());
    }
    return id;
  };
  for (const seg of segments) {
    for (let i = 0; i < seg.length - 1; i++) {
      const a = idOf(seg[i]);
      const b = idOf(seg[i + 1]);
      if (a !== b) {
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
      }
    }
  }
  cachedGraph = { nodes, adj, index };
  return cachedGraph;
}

function nearestNode(g: Graph, target: LngLat): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const d = dist(g.nodes[i], target);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// Dijkstra over the coastline graph (edge weight = great-circle distance).
function shortestPath(
  g: Graph,
  start: number,
  goal: number,
  maxKm = 8,
): LngLat[] | null {
  const distTo = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  while (true) {
    let u = -1;
    let ud = Infinity;
    for (const [n, d] of distTo) {
      if (!visited.has(n) && d < ud) {
        ud = d;
        u = n;
      }
    }
    if (u === -1 || ud > maxKm) break;
    if (u === goal) break;
    visited.add(u);
    for (const v of g.adj.get(u) ?? []) {
      if (visited.has(v)) continue;
      const nd = ud + dist(g.nodes[u], g.nodes[v]);
      if (nd < (distTo.get(v) ?? Infinity)) {
        distTo.set(v, nd);
        prev.set(v, u);
      }
    }
  }
  if (!prev.has(goal) && start !== goal) return null;
  const pathIds: number[] = [goal];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (p === undefined) return null;
    pathIds.push(p);
    cur = p;
  }
  pathIds.reverse();
  return pathIds.map((id) => g.nodes[id]);
}

// The coastline polyline running between two points (their nearest shore
// vertices), or null if the shore is too far / disconnected. `from`/`to` are
// [lon,lat].
export function coastlineArc(
  from: LngLat,
  to: LngLat,
  maxJumpKm = 3,
): LngLat[] | null {
  const g = buildGraph();
  if (!g) return null;
  const a = nearestNode(g, from);
  const b = nearestNode(g, to);
  if (a === -1 || b === -1) return null;
  if (dist(g.nodes[a], from) > maxJumpKm || dist(g.nodes[b], to) > maxJumpKm)
    return null;
  const path = shortestPath(g, a, b, 30);
  return path && path.length >= 2 ? path : null;
}

export type ClosureResult = {
  ring: LngLat[];
  usedCoastline: boolean;
  note?: string;
};

// Close an open sequence of points into a polygon ring. `open` is the ordered
// list of the zone's labelled points ([lon,lat]). We append the coastline path
// from the last point back to the first, when available.
export function closeRing(open: LngLat[]): ClosureResult {
  if (open.length < 2)
    return { ring: open, usedCoastline: false, note: 'too_few_points' };
  const straight = (): ClosureResult => ({
    ring: [...open, open[0]],
    usedCoastline: false,
    note: 'straight_line_close',
  });

  const g = buildGraph();
  if (!g)
    return {
      ring: [...open, open[0]],
      usedCoastline: false,
      note: 'no_coastline_file',
    };

  const first = open[0];
  const last = open[open.length - 1];
  const na = nearestNode(g, last);
  const nb = nearestNode(g, first);
  if (na === -1 || nb === -1) return straight();
  if (dist(g.nodes[na], last) > 3 || dist(g.nodes[nb], first) > 3)
    return straight();

  const coastPath = shortestPath(g, na, nb);
  if (!coastPath || coastPath.length < 2) return straight();

  const ring = [...open, ...coastPath, open[0]];
  return {
    ring,
    usedCoastline: true,
    note: `coastline_vertices:${coastPath.length}`,
  };
}
