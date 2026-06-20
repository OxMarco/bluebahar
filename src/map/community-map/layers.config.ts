// Catalogue of the community "Malta Ranger Unit" Google My Maps layers we
// ingest, and the rules for turning them into Notice-to-Mariners rows.
//
// The map (mid in COMMUNITY_MAP_MID) is hand-curated daily and is authoritative for
// the GEOMETRY and CLASSIFICATION of marine restriction zones. We take its
// polygons and the layer it sits in (which IS the classification); we never
// store its per-placemark description
// text, which is copyrighted. Descriptions are generated from the facts below
// (see enrichMapZone) so nothing derivative of the map's prose is stored.
//
// Only marine layers are listed. The map also carries terrestrial layers (tree
// protection, camping, inland bird sanctuaries, no-BBQ areas) which we exclude
// with dedicated layer matching, placemark allow-lists for mixed folders, and
// the seaward geometry filter.
import { NoticeKind } from '../notice-kind';

export const COMMUNITY_MAP_SOURCE = 'community-map';

// Every zone polygon is ALSO drawn as a cloud of individually-named corner
// markers — "(1A) Blue Lagoon – Comino Swimmers' Zone", "(B) Um el Faroud" —
// one Point per polygon vertex. Their names carry the full zone name (not a
// bare "(A)"), so they can't be told apart by name; instead we ingest only the
// polygon/line geometry and discard standalone Points. Every layer here is an
// area/line restriction zone, so a lone point is always a vertex marker, never
// a real feature.
export interface MapLayerDef {
  // Stable identifier used to namespace each zone's hashed subKey so the
  // unique(source, subKey) constraint dedups daily re-imports.
  key: string;
  // Matches the KML <Folder> name. A regex (not exact) so a yearly rename of the
  // swimmer-zone layer ("… 2026" -> "… 2027") keeps matching.
  match: RegExp;
  kind: NoticeKind;
  // Our own plain-language brief of what the designation legally is. Seeds the
  // AI description. These are FACTS about the restriction class (and the law it
  // rests on), authored by us — not the map's copyrighted placemark prose.
  restrictionBrief: string;
  // Optional allow-list for a mixed folder. A folder-level match alone is not
  // enough for "Other Areas", which also contains terrestrial council, park,
  // camping and BBQ restrictions whose geometry happens to touch the coast.
  placemarkMatch?: RegExp;
}

export const MAP_LAYERS: MapLayerDef[] = [
  {
    key: 'swimmer-zones',
    match: /swimmer zones|restricted navigational areas/i,
    kind: NoticeKind.ALERT,
    restrictionBrief:
      'Area reserved for bathers and closed to navigation. Vessels, fishing ' +
      'gear and any object that could endanger swimmers are prohibited inside ' +
      'the zone; navigate clear of its limits.',
  },
  {
    key: 'wreck-conservation',
    match: /conservation areas around wrecks/i,
    kind: NoticeKind.ALERT,
    restrictionBrief:
      'Conservation area around a protected historic wreck. Entry and mooring ' +
      'are limited to vessels engaged in recreational or technical diving, ' +
      'after pre-notifying Valletta VTS.',
  },
  {
    key: 'archaeological-zones',
    match: /archaeological zones at sea/i,
    kind: NoticeKind.ALERT,
    restrictionBrief:
      'Underwater archaeological zone designated by the Superintendence of ' +
      'Cultural Heritage. No-stopping area: anchoring and mooring are ' +
      'prohibited except for AIS-fitted permitted dive vessels.',
  },
  {
    key: 'life-garnija',
    match: /life garnija/i,
    kind: NoticeKind.ALERT,
    restrictionBrief:
      'Seabird (Yelkouan shearwater) protection area at sea. No navigation and ' +
      'no anchoring except for fishing, diving and local commercial vessels, ' +
      'which must show only compulsory lights and sound.',
  },
  {
    key: 'other-restrictions',
    match: /other areas with restrictions/i,
    kind: NoticeKind.ALERT,
    restrictionBrief:
      'Coastal area subject to local navigational or environmental ' +
      'restrictions. Observe posted limits on access, speed and activity.',
    placemarkMatch: /^Bay Pillar\b/i,
  },
];

// Match a KML folder name to its layer definition, or null if it's a layer we
// don't ingest (terrestrial / out of scope).
export function matchLayer(folderName: string): MapLayerDef | null {
  return MAP_LAYERS.find((l) => l.match.test(folderName)) ?? null;
}

export function matchesPlacemark(
  layer: MapLayerDef,
  placemarkName: string,
): boolean {
  return layer.placemarkMatch?.test(placemarkName) ?? true;
}
