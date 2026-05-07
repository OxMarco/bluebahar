// Maltese maritime places. Used to resolve facility-kind notices (e.g. "vessel
// sunk in Kalkara harbour") into coordinates so they can render on the map.
// Misses fall through to needsReview so a human can curate the entry — coords
// are NEVER LLM-generated.
//
// Coordinates are approximate centroids / representative polygons; intent is
// "good enough to draw on a map", not survey-grade. Add new entries as Sentry
// flags un-resolvable locationLabels.

export type GazetteerEntry =
  | {
      kind: 'point';
      lat: number;
      long: number;
      // Default radius in metres for the marker on the map.
      distance: number;
    }
  | {
      kind: 'polygon';
      points: { lat: number; long: number }[];
    };

interface NamedEntry {
  // Canonical name + alternative spellings/aliases. Match is case-insensitive
  // and normalises whitespace + diacritics.
  names: string[];
  entry: GazetteerEntry;
}

const ENTRIES: NamedEntry[] = [
  {
    names: ['Grand Harbour', 'Valletta Grand Harbour', 'Port of Valletta'],
    entry: {
      kind: 'polygon',
      points: [
        { lat: 35.8975, long: 14.5125 },
        { lat: 35.8985, long: 14.5275 },
        { lat: 35.8895, long: 14.5305 },
        { lat: 35.8865, long: 14.5215 },
        { lat: 35.8895, long: 14.5135 },
      ],
    },
  },
  {
    names: ['Marsamxett Harbour', 'Marsamxetto Harbour', 'Marsamxett'],
    entry: {
      kind: 'polygon',
      points: [
        { lat: 35.9035, long: 14.5045 },
        { lat: 35.9085, long: 14.5165 },
        { lat: 35.9015, long: 14.5215 },
        { lat: 35.8965, long: 14.5095 },
      ],
    },
  },
  {
    names: [
      'Marsaxlokk',
      'Marsaxlokk Bay',
      'Marsaxlokk Harbour',
      'Port of Marsaxlokk',
    ],
    entry: {
      kind: 'polygon',
      points: [
        { lat: 35.8425, long: 14.5395 },
        { lat: 35.8475, long: 14.5645 },
        { lat: 35.8265, long: 14.5705 },
        { lat: 35.8195, long: 14.5485 },
      ],
    },
  },
  {
    names: [
      'Mgarr Harbour',
      'Mġarr Harbour',
      'Mgarr',
      'Mġarr',
      'Port of Mgarr',
    ],
    entry: { kind: 'point', lat: 36.0275, long: 14.2945, distance: 350 },
  },
  {
    names: ['Kalkara', 'Kalkara Harbour', 'Kalkara Creek'],
    entry: { kind: 'point', lat: 35.8895, long: 14.5285, distance: 300 },
  },
  {
    names: ['Birgu', 'Vittoriosa', 'Birgu (Vittoriosa)'],
    entry: { kind: 'point', lat: 35.8875, long: 14.5235, distance: 250 },
  },
  {
    names: ['Senglea', 'Isla', 'Senglea (Isla)'],
    entry: { kind: 'point', lat: 35.8865, long: 14.5175, distance: 200 },
  },
  {
    names: ['Cospicua', 'Bormla', 'Cospicua (Bormla)'],
    entry: { kind: 'point', lat: 35.8835, long: 14.5235, distance: 250 },
  },
  {
    names: ['Sliema Creek', 'Sliema'],
    entry: { kind: 'point', lat: 35.9135, long: 14.5045, distance: 400 },
  },
  {
    names: ['Msida Creek', 'Msida Marina', 'Msida'],
    entry: { kind: 'point', lat: 35.8985, long: 14.4955, distance: 250 },
  },
  {
    names: ['Pieta Creek', 'Pietà Creek', 'Lazzaretto Creek', 'Pieta', 'Pietà'],
    entry: { kind: 'point', lat: 35.8975, long: 14.5005, distance: 200 },
  },
  {
    names: ['Cirkewwa', 'Ċirkewwa', 'Cirkewwa Harbour'],
    entry: { kind: 'point', lat: 36.0118868, long: 14.3369304, distance: 1000 },
  },
  {
    names: ['Comino', 'Kemmuna', 'Blue Lagoon'],
    entry: { kind: 'point', lat: 36.0125, long: 14.3265, distance: 600 },
  },
  /////
  {
    names: [
      "St Paul's Bay",
      "Saint Paul's Bay",
      'San Pawl il-Bahar',
      'St Pauls Bay',
    ],
    entry: { kind: 'point', lat: 35.9480742, long: 14.3973929, distance: 500 },
  },
  {
    names: ['Salina Bay', 'Salina'],
    entry: { kind: 'point', lat: 35.9456238, long: 14.4184239, distance: 500 },
  },
  {
    names: ['Mellieha Bay', 'Mellieħa Bay', 'Ghadira Bay', 'Għadira Bay'],
    entry: { kind: 'point', lat: 35.9700802, long: 14.3503368, distance: 500 },
  },
  {
    names: ['Xemxija Bay', 'Xemxija'],
    entry: { kind: 'point', lat: 35.9482217, long: 14.387934, distance: 500 },
  },
  {
    names: ['Gozo Channel', 'Comino Channel', 'Channel between Malta and Gozo'],
    entry: { kind: 'point', lat: 36.00076, long: 14.31854, distance: 1000 },
  },
  {
    names: ['Xlendi Bay', 'Xlendi'],
    entry: { kind: 'point', lat: 36.0298848, long: 14.2161926, distance: 500 },
  },
  {
    names: ['Marsalforn', 'Marsalforn Bay'],
    entry: { kind: 'point', lat: 36.0712984, long: 14.2595701, distance: 500 },
  },
  {
    names: ['Dwejra', 'Dwejra Bay'],
    entry: { kind: 'point', lat: 36.0467778, long: 14.1912207, distance: 500 },
  },
];

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Build the lookup index once at module load.
const INDEX: { needle: string; entry: GazetteerEntry }[] = ENTRIES.flatMap(
  ({ names, entry }) => names.map((n) => ({ needle: normalize(n), entry })),
);

export function lookupPlace(label: string): GazetteerEntry | null {
  const haystack = normalize(label);
  if (!haystack) return null;

  // Exact normalized match wins.
  const exact = INDEX.find((row) => row.needle === haystack);
  if (exact) return exact.entry;

  // Containment in either direction — handles "Berth 12, Grand Harbour" matching
  // "Grand Harbour" and "Marsaxlokk Bay" matching "Marsaxlokk Bay" alike.
  // Prefer the longest-needle match so "Grand Harbour" beats "Harbour".
  const contained = INDEX.filter(
    (row) => haystack.includes(row.needle) || row.needle.includes(haystack),
  ).sort((a, b) => b.needle.length - a.needle.length);

  return contained[0]?.entry ?? null;
}

// Convert a gazetteer entry to the wire-format `area` array used by ParsedNotice.
// Pure geometry; the rendering radius for point entries lives in
// `GazetteerEntry.distance` and is surfaced as a fallback `distance` on the
// notice itself by the extractor.
export function entryToArea(
  entry: GazetteerEntry,
): { lat: number; long: number }[] {
  if (entry.kind === 'point') {
    return [{ lat: entry.lat, long: entry.long }];
  }
  return entry.points.map((p) => ({ lat: p.lat, long: p.long }));
}
