// Shared, strategy-agnostic extraction model, vendored from the mariner-parser
// project (bench/types.ts). The deterministic regex reader produces a
// `NoticeExtraction`; geometry.ts turns it into plottable GeoJSON.

export type DocumentType =
  | 'new_restriction'
  | 'amendment'
  | 'chart_correction'
  | 'time_extension'
  | 'cancellation'
  | 'unknown';

// How an area's outline should be realised as GeoJSON.
//  - polygon_coastline: open point sequence closed by following the intermediate coastline
//  - polygon:           point sequence that closes on itself without coastline help
//  - circle:            radius_nm around a single centre point
//  - cliff_buffer:      "minimum distance X m from the cliff" — a buffer off the coastline
//  - linestring:        an open line (e.g. a submarine cable limit) — NOT an enclosed area
//  - point:             single position
//  - none:              no geometry (notice has no coordinates)
export type GeometryKind =
  | 'polygon_coastline'
  | 'polygon'
  | 'circle'
  | 'sector' // pie wedge: centre + two rim radii (e.g. a firing danger sector)
  | 'cliff_buffer'
  | 'linestring'
  | 'point'
  | 'none';

export type Operation = 'insert' | 'delete' | 'amended' | 'new' | null;

export type ResolvedPoint = {
  label: string; // e.g. "1A", or a generated "P1" when the source row was unlabeled
  lat: number;
  lon: number;
};

export type Area = {
  area_id: string;
  name: string | null; // location name, e.g. "Blue Grotto – Qrendi"
  chart: string | null; // e.g. "Chart 1" or "BA 211A"
  zone_color: 'red' | 'blue' | null;
  hazard_type: string | null;
  operation: Operation;
  geometry_kind: GeometryKind;
  point_labels: string[]; // ordered label sequence used to build the geometry
  points: ResolvedPoint[]; // resolved lat/lon for those labels (strategy fills these in)
  radius_nm: number | null; // for circle
  buffer_m: number | null; // for cliff_buffer
  restrictions: string[];
};

export type NoticeExtraction = {
  source_file: string;
  notice_no: string | null;
  notice_year: string | null;
  date: string | null; // ISO YYYY-MM-DD
  title: string | null;
  document_type: DocumentType;
  valid_from: string | null; // ISO date or UTC timestamp
  valid_to: string | null; // ISO date or UTC timestamp
  referenced_notices: string[]; // e.g. ["09/2023"]
  charts_affected: string[];
  areas: Area[];
};

// Strategy metadata: latency and free-form notes (coord counts, fallbacks).
export type StrategyMeta = {
  latency_ms: number;
  model: string | null;
  notes: string[];
};
