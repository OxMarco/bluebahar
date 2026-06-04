import type { FeatureCollection, Geometry } from 'geojson';
import { adaptToParsedNotice, type AdaptInput } from './adapter';
import { NoticeKind } from '../../notice-kind';
import type { Area, NoticeExtraction } from './types';
import type { Enrichment } from './enrich';

function extraction(over: Partial<NoticeExtraction> = {}): NoticeExtraction {
  return {
    source_file: 'Not_99_of_2026.pdf',
    notice_no: '99',
    notice_year: '2026',
    date: '2026-06-01',
    title: 'Test restriction area',
    document_type: 'new_restriction',
    valid_from: '2026-06-01',
    valid_to: null,
    referenced_notices: [],
    charts_affected: [],
    areas: [],
    ...over,
  };
}

function fc(
  features: Array<{
    geometry: Geometry | null;
    properties?: Record<string, unknown>;
  }>,
): FeatureCollection<Geometry | null> {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: f.properties ?? {},
    })),
  };
}

function input(over: Partial<AdaptInput> = {}): AdaptInput {
  return {
    source: 'https://example.test/notice.pdf',
    extraction: extraction(),
    featureCollection: fc([]),
    enrichment: null,
    notes: ['coords:0'],
    ...over,
  };
}

const area = (over: Partial<Area> = {}): Area => ({
  area_id: 'a1',
  name: 'Zone A',
  chart: null,
  zone_color: null,
  hazard_type: null,
  operation: 'new',
  geometry_kind: 'polygon',
  point_labels: [],
  points: [],
  radius_nm: null,
  buffer_m: null,
  restrictions: [],
  ...over,
});

describe('adaptToParsedNotice', () => {
  it('maps each GeoJSON geometry type to entity geometry parts ([lon,lat] -> {lat,long})', () => {
    const result = adaptToParsedNotice(
      input({
        featureCollection: fc([
          {
            geometry: { type: 'Point', coordinates: [14.5, 35.9] },
            properties: { name: 'Pt' },
          },
          {
            geometry: {
              type: 'LineString',
              coordinates: [
                [14.5, 35.9],
                [14.6, 36.0],
              ],
            },
            properties: { name: 'Cable' },
          },
          {
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [14.5, 35.9],
                  [14.6, 35.9],
                  [14.6, 36.0],
                  [14.5, 35.9],
                ],
              ],
            },
            properties: { name: 'Zone' },
          },
        ]),
      }),
    );

    expect(result.areas).toHaveLength(3);
    expect(result.areas[0]).toEqual({
      label: 'Pt',
      geometryType: 'point',
      points: [{ lat: 35.9, long: 14.5 }],
    });
    expect(result.areas[1].geometryType).toBe('line');
    expect(result.areas[1].points).toHaveLength(2);
    expect(result.areas[2].geometryType).toBe('polygon');
    expect(result.areas[2].points[0]).toEqual({ lat: 35.9, long: 14.5 });
    expect(result.kind).toBe(NoticeKind.AREA);
  });

  it('splits MultiPolygon and GeometryCollection into multiple labelled parts', () => {
    const multi: Geometry = {
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [14.5, 35.9],
            [14.6, 35.9],
            [14.6, 36.0],
            [14.5, 35.9],
          ],
        ],
        [
          [
            [14.7, 35.8],
            [14.8, 35.8],
            [14.8, 35.9],
            [14.7, 35.8],
          ],
        ],
      ],
    };
    const result = adaptToParsedNotice(
      input({
        featureCollection: fc([
          { geometry: multi, properties: { name: 'Buf' } },
        ]),
      }),
    );
    expect(result.areas).toHaveLength(2);
    expect(result.areas.map((a) => a.label)).toEqual(['Buf (1)', 'Buf (2)']);
    expect(result.areas.every((a) => a.geometryType === 'polygon')).toBe(true);
  });

  it('classifies a notice with no plottable geometry as advisory', () => {
    const result = adaptToParsedNotice(
      input({
        extraction: extraction({ document_type: 'cancellation', areas: [] }),
        featureCollection: fc([{ geometry: null, properties: {} }]),
        notes: ['coords:0'],
      }),
    );
    expect(result.kind).toBe(NoticeKind.ADVISORY);
    expect(result.areas).toHaveLength(0);
    expect(result.needsReview).toBe(false);
    expect(result.reviewReasons).toEqual([]);
  });

  describe('needsReview', () => {
    it('flags serious geometry warnings', () => {
      const result = adaptToParsedNotice(
        input({
          featureCollection: fc([
            {
              geometry: { type: 'Point', coordinates: [14.5, 35.9] },
              properties: { warnings: ['point_outside_malta_bbox:1A'] },
            },
          ]),
        }),
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReasons).toContain('point_outside_malta_bbox:1A');
    });

    it('does NOT flag a coastline-closure straight-line fallback (still plottable)', () => {
      const result = adaptToParsedNotice(
        input({
          featureCollection: fc([
            {
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [14.5, 35.9],
                    [14.6, 35.9],
                    [14.6, 36.0],
                    [14.5, 35.9],
                  ],
                ],
              },
              properties: {
                warnings: ['coastline_closure_fallback:straight_line_close'],
              },
            },
          ]),
        }),
      );
      expect(result.needsReview).toBe(false);
      expect(result.reviewReasons).toEqual([]);
    });

    it('flags a restriction that yielded no geometry despite having coordinates', () => {
      const result = adaptToParsedNotice(
        input({
          extraction: extraction({ document_type: 'new_restriction' }),
          featureCollection: fc([{ geometry: null, properties: {} }]),
          notes: ['coords:6'],
        }),
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReasons).toContain(
        'restriction_with_coordinates_but_no_geometry',
      );
    });

    it('flags a likely-scanned PDF', () => {
      const result = adaptToParsedNotice(
        input({ notes: ['coords:0', 'likely_scanned_pdf:empty_text_layer'] }),
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReasons).toContain(
        'likely_scanned_pdf:empty_text_layer',
      );
    });

    it('flags generic fallback geometries for manual verification', () => {
      const result = adaptToParsedNotice(
        input({
          extraction: extraction({
            areas: [
              area({
                restrictions: ['generic extraction — verify geometry'],
              }),
            ],
          }),
          featureCollection: fc([
            {
              geometry: { type: 'Point', coordinates: [14.5, 35.9] },
              properties: {},
            },
          ]),
        }),
      );
      expect(result.needsReview).toBe(true);
      expect(result.reviewReasons).toContain(
        'generic_extraction_verify_geometry',
      );
    });
  });

  describe('description + metadata', () => {
    it('uses AI enrichment summary + action when present', () => {
      const enrichment: Enrichment = {
        category: 'alert',
        summary: 'Live firing at Pembroke.',
        recommended_action: 'Keep 4 NM off the coast.',
        affected_locations: ['Pembroke Ranges'],
        validity: '8 June 2026',
        model: 'gpt-5.5',
        latency_ms: 10,
      };
      const result = adaptToParsedNotice(input({ enrichment }));
      expect(result.description).toBe(
        'Live firing at Pembroke.\n\nKeep 4 NM off the coast.',
      );
      expect(result.locationLabel).toBe('Pembroke Ranges');
    });

    it('falls back to a rule-based description from hazards/restrictions', () => {
      const result = adaptToParsedNotice(
        input({
          extraction: extraction({
            document_type: 'new_restriction',
            charts_affected: ['BA 2538'],
            areas: [
              area({
                hazard_type: 'no_anchoring',
                restrictions: ['No anchoring within the zone.'],
              }),
            ],
          }),
        }),
      );
      expect(result.description).toContain('New restriction.');
      expect(result.description).toContain('Hazard: no anchoring.');
      expect(result.description).toContain('No anchoring within the zone.');
      expect(result.description).toContain('Charts affected: BA 2538.');
    });

    it('parses ISO dates and leaves activeTo undefined when absent', () => {
      const result = adaptToParsedNotice(
        input({
          extraction: extraction({
            date: '2026-06-01',
            valid_from: '2026-06-02',
            valid_to: null,
          }),
        }),
      );
      expect(result.publishedAt.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(result.activeFrom.toISOString()).toBe('2026-06-02T00:00:00.000Z');
      expect(result.activeTo).toBeUndefined();
    });

    it('parses timestamp validity and treats date-only activeTo as end-of-day', () => {
      const exact = adaptToParsedNotice(
        input({
          extraction: extraction({
            valid_from: '2026-06-08T14:30:00.000Z',
            valid_to: '2026-06-08T16:00:00.000Z',
          }),
        }),
      );
      expect(exact.activeFrom.toISOString()).toBe('2026-06-08T14:30:00.000Z');
      expect(exact.activeTo?.toISOString()).toBe('2026-06-08T16:00:00.000Z');

      const dateOnly = adaptToParsedNotice(
        input({
          extraction: extraction({
            valid_to: '2026-06-08',
          }),
        }),
      );
      expect(dateOnly.activeTo?.toISOString()).toBe('2026-06-08T23:59:59.999Z');
    });

    it('derives title from referenceId when the extraction has no title', () => {
      const result = adaptToParsedNotice(
        input({ extraction: extraction({ title: null }) }),
      );
      expect(result.title).toBe('99/2026');
      expect(result.subKey).toBe('');
    });
  });
});
