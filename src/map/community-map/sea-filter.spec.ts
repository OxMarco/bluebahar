import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The coastline loaders read COASTLINE_FILE / MALTESE_WATERS_FILE lazily on
// first use, so setting them before the first sea-filter call (and resetting
// the memoised sea polygon) points the filter at deterministic fixtures: a
// large "waters" box with a smaller "land" box punched out of it.
const dir = mkdtempSync(join(tmpdir(), 'community-map-sea-'));

function box(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): object {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
        [minLon, minLat],
      ],
    ],
  };
}

const watersFile = join(dir, 'waters.geojson');
const landFile = join(dir, 'land.geojson');
writeFileSync(watersFile, JSON.stringify(box(14.0, 35.8, 14.6, 36.1)));
writeFileSync(landFile, JSON.stringify(box(14.2, 35.85, 14.4, 35.95)));

process.env.MALTESE_WATERS_FILE = watersFile;
process.env.COASTLINE_FILE = landFile;

// Imported AFTER the env is set; the loaders still resolve lazily, but being
// explicit keeps the ordering obvious.
import {
  _resetSeaCache,
  filterMarineGeometries,
  isMarineGeometry,
} from './sea-filter';
import type { ZoneGeometry } from './kml-source';

beforeAll(() => _resetSeaCache());

describe('sea-filter', () => {
  it('drops a point that lies on land', () => {
    const onLand: ZoneGeometry = { type: 'point', points: [[14.3, 35.9]] };
    expect(isMarineGeometry(onLand)).toBe(false);
  });

  it('keeps a point offshore', () => {
    const atSea: ZoneGeometry = { type: 'point', points: [[14.5, 36.0]] };
    expect(isMarineGeometry(atSea)).toBe(true);
  });

  it('keeps a coastal polygon that straddles the shoreline', () => {
    // Spans the land boundary at lon 14.4: the lon>14.4 half is sea.
    const straddle: ZoneGeometry = {
      type: 'polygon',
      points: [
        [14.38, 35.9],
        [14.45, 35.9],
        [14.45, 35.95],
        [14.38, 35.95],
      ],
    };
    expect(isMarineGeometry(straddle)).toBe(true);
  });

  it('drops a polygon entirely on land', () => {
    const inland: ZoneGeometry = {
      type: 'polygon',
      points: [
        [14.25, 35.88],
        [14.3, 35.88],
        [14.3, 35.92],
        [14.25, 35.92],
      ],
    };
    expect(isMarineGeometry(inland)).toBe(false);
  });

  it('filterMarineGeometries keeps only the sea-touching shapes of a zone', () => {
    const geoms: ZoneGeometry[] = [
      { type: 'point', points: [[14.3, 35.9]] }, // land -> dropped
      { type: 'point', points: [[14.5, 36.0]] }, // sea -> kept
    ];
    expect(filterMarineGeometries(geoms)).toEqual([geoms[1]]);
  });
});
