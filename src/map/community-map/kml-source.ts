// Minimal KML reader for the community map export. We parse the KML ourselves
// (via @xmldom/xmldom) rather than reach for togeojson because we need the
// <Folder> grouping — the folder a placemark sits in IS its classification
// (see layers.config.ts) — and togeojson's kml() discards folder hierarchy.
//
// We only need the geometry types this map actually uses: Point, LineString,
// Polygon, and MultiGeometry combinations of those. Holes/altitude are ignored
// (the curated zones are simple outer rings).
import { DOMParser } from '@xmldom/xmldom';
import { fetchText } from '../../common/utils/http';

export type LngLat = [number, number]; // [lon, lat]

// One drawable shape. Mirrors the three geometryTypes the notice model stores
// (point/line/polygon); `points` is an open coordinate list (a polygon ring may
// be open — downstream closes it).
export interface ZoneGeometry {
  type: 'point' | 'line' | 'polygon';
  points: LngLat[];
}

export interface KmlPlacemark {
  name: string;
  // Raw description (HTML/CDATA). We read it only for facts — the validity
  // window and the underlying notice number — never to store its prose.
  description: string;
  geometries: ZoneGeometry[];
}

export interface KmlFolder {
  name: string;
  placemarks: KmlPlacemark[];
}

// The shorturl form resolves to a kml export; forcekml=1 inlines every layer
// (the default network-linked KMZ would need a second fetch per layer).
export function communityMapKmlUrl(mid: string): string {
  return `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`;
}

export async function fetchCommunityMapKml(mid: string): Promise<string> {
  return fetchText(communityMapKmlUrl(mid));
}

function text(node: Element | null): string {
  return (node?.textContent ?? '').trim();
}

// "lon,lat,alt lon,lat,alt …" (whitespace between tuples, comma within) -> points.
function parseCoordinates(raw: string): LngLat[] {
  const tuples = raw.trim().split(/\s+/).filter(Boolean);
  if (tuples.length === 0) {
    throw new Error('Community-map KML contains empty coordinates');
  }
  return tuples.map((tuple): LngLat => {
    const [lon, lat] = tuple.split(',');
    const x = Number(lon);
    const y = Number(lat);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < -180 ||
      x > 180 ||
      y < -90 ||
      y > 90
    ) {
      throw new Error(
        `Community-map KML contains invalid coordinates: ${tuple}`,
      );
    }
    return [x, y];
  });
}

function assertDistinctPoints(
  type: 'line' | 'polygon',
  points: LngLat[],
  minimum: number,
): void {
  const distinct = new Set(points.map(([lon, lat]) => `${lon},${lat}`));
  if (distinct.size < minimum) {
    throw new Error(`Community-map KML contains a degenerate ${type} geometry`);
  }
}

function firstChildText(el: Element, tag: string): string {
  // Document order: a Folder/Placemark's own <name> precedes any descendant's,
  // so index 0 is the element's own name rather than a child placemark's.
  const found = el.getElementsByTagName(tag);
  return found.length ? text(found[0]) : '';
}

function geometriesFor(pm: Element): ZoneGeometry[] {
  const out: ZoneGeometry[] = [];

  // Point / LineString / Polygon are distinct tags; getElementsByTagName is
  // recursive, so a MultiGeometry wrapper needs no special handling — its
  // children surface here directly.
  for (const pt of Array.from(pm.getElementsByTagName('Point'))) {
    const pts = parseCoordinates(firstChildText(pt, 'coordinates'));
    if (pts.length) out.push({ type: 'point', points: pts.slice(0, 1) });
  }
  for (const ls of Array.from(pm.getElementsByTagName('LineString'))) {
    const pts = parseCoordinates(firstChildText(ls, 'coordinates'));
    assertDistinctPoints('line', pts, 2);
    out.push({ type: 'line', points: pts });
  }
  for (const poly of Array.from(pm.getElementsByTagName('Polygon'))) {
    // Outer ring only: prefer outerBoundaryIs, else the first LinearRing.
    const el = poly;
    const outer = el.getElementsByTagName('outerBoundaryIs');
    const ring = outer.length ? outer[0] : el;
    const pts = parseCoordinates(firstChildText(ring, 'coordinates'));
    assertDistinctPoints('polygon', pts, 3);
    out.push({ type: 'polygon', points: pts });
  }

  return out;
}

// Parse a KML document into its folders and the placemarks (with geometry) each
// contains. Placemarks outside any folder are ignored — every layer on this map
// lives in a folder. Assumes a flat folder structure (no nested folders), which
// this map uses; nested folders would over-count placemarks into the parent.
export function parseKmlFolders(xml: string): KmlFolder[] {
  const parseErrors: string[] = [];
  let doc: ReturnType<DOMParser['parseFromString']>;
  try {
    doc = new DOMParser({
      onError: (_level, message) => {
        parseErrors.push(message);
      },
    }).parseFromString(xml, 'text/xml');
  } catch {
    throw new Error('Community-map response is not valid KML');
  }
  const root = doc.documentElement;
  if (
    parseErrors.length > 0 ||
    !root ||
    (root.localName || root.tagName).toLowerCase() !== 'kml'
  ) {
    throw new Error('Community-map response is not valid KML');
  }
  const folders: KmlFolder[] = [];

  for (const folder of Array.from(doc.getElementsByTagName('Folder'))) {
    const fEl = folder as unknown as Element;
    const name = firstChildText(fEl, 'name');
    const placemarks: KmlPlacemark[] = [];
    for (const pm of Array.from(fEl.getElementsByTagName('Placemark'))) {
      const pmEl = pm;
      const geometries = geometriesFor(pmEl);
      if (geometries.length === 0) continue; // metadata-only placemark
      placemarks.push({
        name: firstChildText(pmEl, 'name'),
        description: firstChildText(pmEl, 'description'),
        geometries,
      });
    }
    folders.push({ name, placemarks });
  }

  return folders;
}
