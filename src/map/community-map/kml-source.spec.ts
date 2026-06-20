import { communityMapKmlUrl, parseKmlFolders } from './kml-source';

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Test map</name>
    <Folder>
      <name>Conservation Areas around Wrecks – Notice to Mariners 113 of 2024</name>
      <Placemark>
        <name>Um el Faroud</name>
        <Polygon><outerBoundaryIs><LinearRing><coordinates>
          14.44,35.81,0 14.45,35.81,0 14.45,35.82,0 14.44,35.82,0 14.44,35.81,0
        </coordinates></LinearRing></outerBoundaryIs></Polygon>
      </Placemark>
      <Placemark>
        <name>(A) Um el Faroud</name>
        <Point><coordinates>14.44,35.81,0</coordinates></Point>
      </Placemark>
    </Folder>
    <Folder>
      <name>Other Areas with Restrictions</name>
      <Placemark>
        <name>A line zone</name>
        <LineString><coordinates>14.30,35.90,0 14.31,35.91,0</coordinates></LineString>
      </Placemark>
      <Placemark>
        <name>Two-part zone</name>
        <MultiGeometry>
          <Polygon><outerBoundaryIs><LinearRing><coordinates>
            14.20,35.90,0 14.21,35.90,0 14.21,35.91,0 14.20,35.90,0
          </coordinates></LinearRing></outerBoundaryIs></Polygon>
          <Point><coordinates>14.25,35.95,0</coordinates></Point>
        </MultiGeometry>
      </Placemark>
      <Placemark>
        <name>Metadata only</name>
      </Placemark>
    </Folder>
  </Document>
</kml>`;

describe('kml-source', () => {
  it('builds the forcekml export url', () => {
    expect(communityMapKmlUrl('abc123')).toBe(
      'https://www.google.com/maps/d/kml?mid=abc123&forcekml=1',
    );
  });

  it('groups placemarks by folder and parses each geometry type', () => {
    const folders = parseKmlFolders(KML);
    expect(folders.map((f) => f.name)).toEqual([
      'Conservation Areas around Wrecks – Notice to Mariners 113 of 2024',
      'Other Areas with Restrictions',
    ]);

    const wreck = folders[0];
    expect(wreck.placemarks).toHaveLength(2);
    const polygon = wreck.placemarks.find((p) => p.name === 'Um el Faroud')!;
    expect(polygon.geometries).toHaveLength(1);
    expect(polygon.geometries[0].type).toBe('polygon');
    expect(polygon.geometries[0].points[0]).toEqual([14.44, 35.81]);

    // The lettered vertex marker is still parsed here (the import layer skips it
    // by name) — it's a point.
    const marker = wreck.placemarks.find((p) => p.name === '(A) Um el Faroud')!;
    expect(marker.geometries[0].type).toBe('point');
  });

  it('expands MultiGeometry into multiple shapes and drops metadata-only placemarks', () => {
    const other = parseKmlFolders(KML)[1];
    // 'Metadata only' has no geometry -> dropped; line + multigeometry remain.
    expect(other.placemarks.map((p) => p.name)).toEqual([
      'A line zone',
      'Two-part zone',
    ]);
    const multi = other.placemarks.find((p) => p.name === 'Two-part zone')!;
    expect(multi.geometries.map((g) => g.type).sort()).toEqual([
      'point',
      'polygon',
    ]);
  });

  it('rejects an HTML response instead of treating it as an empty map', () => {
    expect(() => parseKmlFolders('<html><body>Sign in</body></html>')).toThrow(
      'not valid KML',
    );
  });

  it('rejects malformed XML', () => {
    expect(() => parseKmlFolders('<kml><Document>')).toThrow('not valid KML');
  });

  it('rejects an invalid coordinate instead of silently dropping it', () => {
    const invalid = KML.replace('14.45,35.82,0', 'invalid,35.82,0');
    expect(() => parseKmlFolders(invalid)).toThrow('invalid coordinates');
  });

  it('rejects a degenerate geometry instead of omitting the placemark', () => {
    const degenerate = KML.replace(
      '14.30,35.90,0 14.31,35.91,0',
      '14.30,35.90,0 14.30,35.90,0',
    );
    expect(() => parseKmlFolders(degenerate)).toThrow(
      'degenerate line geometry',
    );
  });
});
