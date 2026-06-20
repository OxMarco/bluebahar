import type OpenAI from 'openai';
import type { KmlFolder, ZoneGeometry } from './kml-source';
import {
  assertSafeSnapshot,
  buildCommunityMapSnapshot,
  CommunityMapImportService,
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

  it('keeps named wreck points but drops prefixed polygon vertex markers', () => {
    const area = polygon([
      [14.498, 35.92],
      [14.4995, 35.92],
      [14.4995, 35.921],
      [14.498, 35.921],
      [14.498, 35.92],
    ]);
    const folders: KmlFolder[] = [
      {
        name: wreckFolder,
        placemarks: [
          {
            name: 'Tug 2',
            description: 'Applies all year round.',
            geometries: [area],
          },
          {
            name: 'Tug 2',
            description: '',
            geometries: [{ type: 'point', points: [[14.498783, 35.920467]] }],
          },
          {
            name: '(A) Tug 2',
            description: '',
            geometries: [{ type: 'point', points: [[14.498, 35.92]] }],
          },
        ],
      },
    ];

    const snapshot = buildCommunityMapSnapshot(folders);

    expect(snapshot.zones).toHaveLength(1);
    expect(
      snapshot.zones[0].geometries.map((geometry) => geometry.type).sort(),
    ).toEqual(['point', 'polygon']);
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
      folderName: '',
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

describe('community-map enrichment review state', () => {
  function serviceWithClient(client: OpenAI): CommunityMapImportService {
    const config = {
      get: jest.fn((key: string) =>
        key === 'OPENAI_API_KEY' ? 'sk-test' : undefined,
      ),
    };
    const service = new CommunityMapImportService(
      config as never,
      {} as never,
      {} as never,
    );
    (service as unknown as { openai: OpenAI }).openai = client;
    return service;
  }

  function describe(
    service: CommunityMapImportService,
    sourceDescription: string,
    priorDescription?: string,
  ) {
    return (
      service as unknown as {
        describe(
          layer: (typeof MAP_LAYERS)[number],
          zoneName: string,
          sourceDescription: string,
          facts: {
            seasonal: Record<string, never>;
            distance: null;
            noticeRef: null;
          },
          priorDescription?: string,
        ): Promise<{
          description: string;
          reviewReasons: string[];
          attemptedAi: boolean;
        }>;
      }
    ).describe(
      MAP_LAYERS[0],
      'Test zone',
      sourceDescription,
      { seasonal: {}, distance: null, noticeRef: null },
      priorDescription,
    );
  }

  it('flags a missing source description without calling AI', async () => {
    const create = jest.fn();
    const service = serviceWithClient({
      responses: { create },
    } as unknown as OpenAI);

    const result = await describe(service, '', 'Previously approved text');

    expect(create).not.toHaveBeenCalled();
    expect(result.description).toBe('Previously approved text');
    expect(result.reviewReasons).toEqual([
      'community-map-source-description-missing',
    ]);
  });

  it('keeps the prior description and flags an AI failure for review', async () => {
    const service = serviceWithClient({
      responses: {
        create: jest.fn().mockRejectedValue(new Error('model unavailable')),
      },
    } as unknown as OpenAI);

    const result = await describe(
      service,
      'Vessels must remain outside this area.',
      'Previously approved text',
    );

    expect(result.description).toBe('Previously approved text');
    expect(result.reviewReasons).toEqual([
      'community-map-ai-enrichment-failed',
    ]);
    expect(result.attemptedAi).toBe(true);
  });

  it('uses the clean curated brief when a new row cannot be enriched', async () => {
    const service = serviceWithClient({
      responses: {
        create: jest.fn().mockRejectedValue(new Error('model unavailable')),
      },
    } as unknown as OpenAI);

    const result = await describe(
      service,
      'Vessels must remain outside this area.',
    );

    expect(result.description).toBe(MAP_LAYERS[0].restrictionBrief);
    expect(result.description).not.toContain('Source details require');
    expect(result.reviewReasons).toEqual([
      'community-map-ai-enrichment-failed',
    ]);
  });

  it('stores extracted rules in the existing description field', async () => {
    const service = serviceWithClient({
      responses: {
        create: jest.fn().mockResolvedValue({
          output_text: JSON.stringify({
            summary: 'A navigation-restricted coastal zone.',
            restrictions: [
              'Vessels must not exceed 5 knots.',
              'Only compulsory lights and sounds may be used.',
            ],
          }),
        }),
      },
    } as unknown as OpenAI);

    const result = await describe(
      service,
      'Maximum speed is 5 knots. Only compulsory lights and sounds.',
    );

    expect(result.reviewReasons).toEqual([]);
    expect(result.description).toContain(
      'Restrictions:\n- Vessels must not exceed 5 knots.',
    );
    expect(result.description).toContain(
      '- Only compulsory lights and sounds may be used.',
    );
    expect(result.description).not.toContain('Recommended action:');
  });
});
