import type { KmlFolder, ZoneGeometry } from './kml-source';
import {
  assertSafeSnapshot,
  buildCommunityMapSnapshot,
  geometryFingerprint,
  stableZoneSubKey,
  type CommunityMapSnapshot,
  type SnapshotZone,
} from './community-map-import.service';
import { MAP_LAYERS } from './layers.config';

const wreckFolder =
  'Conservation Areas around Wrecks – Notice to Mariners 113 of 2024';

function polygon(points: [number, number][]): ZoneGeometry {
  return { type: 'polygon', points };
}

describe('community-map snapshot', () => {
  it('groups repeated placemark names and removes equivalent geometries', () => {
    const first = polygon([
      [14.448667, 35.82],
      [14.453333, 35.819167],
      [14.451167, 35.817833],
      [14.447167, 35.818],
      [14.448667, 35.82],
    ]);
    // Same ring, with a different starting vertex and direction.
    const equivalent = polygon([
      [14.451167, 35.817833],
      [14.453333, 35.819167],
      [14.448667, 35.82],
      [14.447167, 35.818],
      [14.451167, 35.817833],
    ]);
    const secondPart = polygon([
      [14.46, 35.81],
      [14.465, 35.81],
      [14.465, 35.815],
      [14.46, 35.81],
    ]);
    const folders: KmlFolder[] = [
      {
        name: wreckFolder,
        placemarks: [first, equivalent, secondPart].map((geometry) => ({
          name: 'Um el Faroud',
          description: 'Applies all year round.',
          geometries: [geometry],
        })),
      },
    ];

    const snapshot = buildCommunityMapSnapshot(folders);

    expect(snapshot.zones).toHaveLength(1);
    expect(snapshot.zones[0].geometries).toHaveLength(2);
    expect(geometryFingerprint(first)).toBe(geometryFingerprint(equivalent));
  });

  it('uses a stable identity despite casing and whitespace differences', () => {
    expect(stableZoneSubKey('swimmer-zones', 'Blue Lagoon')).toBe(
      stableZoneSubKey('swimmer-zones', '  blue   lagoon  '),
    );
  });

  it('rejects a snapshot with missing configured layers', () => {
    expect(() =>
      assertSafeSnapshot(
        { zones: [], matchedLayerKeys: new Set(['swimmer-zones']) },
        0,
      ),
    ).toThrow('missing configured layers');
  });

  it('rejects a sharp drop before stale rows can be deleted', () => {
    const template: SnapshotZone = {
      layer: MAP_LAYERS[0],
      zoneName: 'Zone',
      subKey: 'zone',
      geometries: [],
      sourceDescription: '',
    };
    const snapshot: CommunityMapSnapshot = {
      zones: Array.from({ length: 60 }, (_, index) => ({
        ...template,
        subKey: `zone-${index}`,
      })),
      matchedLayerKeys: new Set(MAP_LAYERS.map((layer) => layer.key)),
    };

    expect(() => assertSafeSnapshot(snapshot, 120)).toThrow(
      'refusing destructive sync',
    );
  });
});
