import fs from 'node:fs';
import path from 'node:path';
import type { GeoJSON, Geometry, Position } from 'geojson';
import type { LngLat } from './kml-source';

const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_COASTLINE_FILE = path.join(DATA_DIR, 'malta-coastline.geojson');
const DEFAULT_WATERS_FILE = path.join(
  DATA_DIR,
  'maltese-waters-contour.geojson',
);

const toRing = (ring: Position[]): LngLat[] =>
  ring.map((point) => [point[0], point[1]]);

function readGeometries(file: string): Geometry[] {
  const document = JSON.parse(fs.readFileSync(file, 'utf8')) as GeoJSON;
  const geometries: Geometry[] = [];
  const walk = (node: GeoJSON | Geometry | null): void => {
    if (!node) return;
    switch (node.type) {
      case 'FeatureCollection':
        node.features.forEach((feature) => walk(feature.geometry));
        break;
      case 'Feature':
        walk(node.geometry);
        break;
      case 'GeometryCollection':
        node.geometries.forEach(walk);
        break;
      default:
        geometries.push(node);
    }
  };
  walk(document);
  return geometries;
}

function makePolygonLoader(resolveFile: () => string): () => LngLat[][][] {
  let cached: LngLat[][][] | undefined;
  return () => {
    if (cached) return cached;
    const file = resolveFile();
    if (!fs.existsSync(file)) {
      console.warn(`community-map polygon data missing at ${file}`);
      return [];
    }
    const polygons: LngLat[][][] = [];
    for (const geometry of readGeometries(file)) {
      if (geometry.type === 'Polygon') {
        polygons.push(geometry.coordinates.map(toRing));
      } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach((polygon) =>
          polygons.push(polygon.map(toRing)),
        );
      }
    }
    cached = polygons;
    return polygons;
  };
}

export const landPolygons = makePolygonLoader(
  () => process.env.COASTLINE_FILE || DEFAULT_COASTLINE_FILE,
);

export const malteseWatersPolygons = makePolygonLoader(
  () => process.env.MALTESE_WATERS_FILE || DEFAULT_WATERS_FILE,
);
