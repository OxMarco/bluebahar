// Single LLM call that splits a Notice-to-Mariners PDF into one logical
// record per distinct subject. The LLM never produces coordinates — those are
// extracted deterministically by `coordinates.ts` and merged in later via
// heading anchors. This eliminates a class of hallucinations (sign flips,
// DMS-to-decimal errors, lat/long swaps) by construction.

import OpenAI from 'openai';
import { NoticeKind } from '../../notice-kind';

export type OutlineGeometryType = 'point' | 'line' | 'polygon';

export interface OutlineGeometryPart {
  label: string;
  geometryType: OutlineGeometryType;
  // Verbatim nearby heading/phrase when the part has one; null when point
  // labels are the only reliable way to bind coords to this part.
  headingAnchor: string | null;
  // PDF table point labels that belong to this part, in drawing order. Never
  // coordinates; just labels such as ["A", "B", "C"] or ["W", "X", "Y", "Z"].
  pointLabels: string[];
}

export interface OutlineRecord {
  // Stable identifier disambiguating sibling records from the same PDF.
  // Empty string ONLY when the PDF maps to one record. Doubles as the
  // composite-unique-constraint key in the database.
  subKey: string;
  kind: NoticeKind;
  title: string;
  description: string;
  // Required for kind='facility', optional context for 'area', null for 'advisory'.
  locationLabel: string | null;
  publishedAt: string;
  activeFrom: string;
  activeTo: string | null;
  // Safety distance / radius from the hazard, in METRES (LLM converts from
  // any source unit). Null when the notice doesn't state one — many area
  // notices are self-defining polygons with no extra berth requirement.
  distance: number | null;
  // Hazard depth in METRES (LLM converts from any source unit). Null when
  // not stated. Note: this is the depth of the hazard itself (e.g. depth of
  // a wreck), not an operational draught limit.
  depth: number | null;
  // Distinct geographic parts inside this record. For kind='area', there is
  // normally one part, but notices can contain separate polygons/lines that
  // must not be stitched together on the map. Empty for advisory/facility.
  geometryParts: OutlineGeometryPart[];
  // Verbatim heading line as it appears in the extracted PDF text. Used to
  // attach regex-extracted coordinates to this section (see extract.ts).
  // Empty string when there's only one record (then all coords belong to it).
  headingAnchor: string;
  // Inclusive page range within which this section's content lives. Used as
  // a coarse coord-assignment filter; combined with headingAnchor for cases
  // where multiple sections share a page.
  pageStart: number;
  pageEnd: number;
}

// Cheap & fast model — outline is a comprehension task, not deep reasoning.
const MODEL = 'gpt-5.4-mini';

const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    subKey: {
      type: 'string',
      description:
        "Stable identifier (e.g. 'Bunkering Area 1', 'VHF Channel Assignments'). " +
        'Empty string only when the PDF is a single notice.',
    },
    kind: {
      type: 'string',
      enum: ['area', 'facility', 'advisory'],
      description:
        'Classify by section PURPOSE, not whether coordinates appear. ' +
        "'area' = defines/restricts a geographic region. " +
        "'facility' = concerns a named place (berth, lock, channel, port, harbour). " +
        "'advisory' = general guidance, regulatory rules, contact info, channel assignments.",
    },
    title: { type: 'string' },
    description: { type: 'string' },
    locationLabel: {
      type: ['string', 'null'],
      description:
        "Required for 'facility' (e.g. 'Kalkara Harbour'); " +
        "optional context for 'area'; null for 'advisory'.",
    },
    publishedAt: { type: 'string', description: 'ISO 8601 date' },
    activeFrom: { type: 'string', description: 'ISO 8601 date' },
    activeTo: {
      type: ['string', 'null'],
      description: 'ISO 8601 date, null if no expiry',
    },
    distance: {
      type: ['number', 'null'],
      description:
        'Safety distance / wide-berth radius from the hazard, in METRES. ' +
        'Convert from any source unit: 1 nautical mile = 1852m, ' +
        '1 cable = 185.2m, 1 foot = 0.3048m. ' +
        'Null if the notice does not state a safety distance.',
    },
    depth: {
      type: ['number', 'null'],
      description:
        'Depth of the hazard itself in METRES (e.g. depth of a wreck below sea level). ' +
        'NOT an operational draught limit. Convert from any source unit: ' +
        '1 foot = 0.3048m, 1 fathom = 1.8288m. Null if not stated.',
    },
    geometryParts: {
      type: 'array',
      description:
        "For kind='area', one entry per distinct geometry that should be drawn separately. " +
        'Use pointLabels to bind table rows without extracting coordinates. Empty for facility/advisory.',
      items: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
            description:
              'Short label for this geometry part, e.g. "A-E removal area", "F-G silt curtain", or "Ir-Ramla tal-Mixquqa".',
          },
          geometryType: {
            type: 'string',
            enum: ['point', 'line', 'polygon'],
            description:
              "'point' = one hazard/position; 'line' = route, cable, curtain, or two-point segment; 'polygon' = bounded/enclosed area.",
          },
          headingAnchor: {
            type: ['string', 'null'],
            description:
              'Verbatim nearby phrase/heading that introduces this part, or null when no stable phrase exists.',
          },
          pointLabels: {
            type: 'array',
            description:
              'Table point labels for this part in drawing order. Do not include coordinates. Example: ["A", "B", "C", "D"].',
            items: { type: 'string' },
          },
        },
        required: ['label', 'geometryType', 'headingAnchor', 'pointLabels'],
        additionalProperties: false,
      },
    },
    headingAnchor: {
      type: 'string',
      description:
        'Verbatim heading line as it appears in the PDF text (e.g. "Bunkering Area 1"). ' +
        'Used to attach extracted coordinates to this section. ' +
        'Empty string only when the PDF is a single notice.',
    },
    pageStart: { type: 'integer', minimum: 1 },
    pageEnd: { type: 'integer', minimum: 1 },
  },
  required: [
    'subKey',
    'kind',
    'title',
    'description',
    'locationLabel',
    'publishedAt',
    'activeFrom',
    'activeTo',
    'distance',
    'depth',
    'geometryParts',
    'headingAnchor',
    'pageStart',
    'pageEnd',
  ],
  additionalProperties: false,
} as const;

const OUTLINE_SCHEMA = {
  type: 'object',
  properties: {
    notices: {
      type: 'array',
      description:
        'One entry per distinct subject in the PDF. Most NTMs are a single record. ' +
        'Composite PDFs (multiple bunkering areas, separate VTS zones, mixed advisory + area sections) ' +
        'must be split — each record covers ONE subject only.',
      items: RECORD_SCHEMA,
    },
  },
  required: ['notices'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  'You read a Maltese maritime "Notice to Mariners" PDF (provided as page-broken text)',
  'and split it into one record per distinct subject. You do NOT extract coordinates —',
  'those are taken from the PDF separately.',
  '',
  'Splitting rules:',
  '- A PDF that lists several bunkering areas, anchorages, or wreck sites yields one record per area.',
  '- A PDF that mixes regulatory rules, area definitions, and contact info yields one record per cohesive section.',
  '- Most short PDFs are a single record.',
  '- A single cohesive record may still contain multiple geographic parts; keep those inside geometryParts rather than forcing separate records when the subject/dates/instructions are shared.',
  '',
  'Classification (by PURPOSE, not by whether coordinates appear):',
  "- 'area': the section defines or restricts a geographic region.",
  "- 'facility': the section concerns a named place without coordinate boundaries (berth, port, harbour, channel).",
  "- 'advisory': general guidance, regulatory rules, contact info, VHF channel assignments.",
  '',
  'For each record:',
  '- title: a SHORT descriptive label for the subject (e.g. "Submerged vessel at Kalkara", "Bunkering Area 1", "Misuse of distress signals"). NEVER use the document header ("LOCAL NOTICE TO MARINERS Nxxx OF yyyy") as the title — readers see that elsewhere. Aim for ≤80 characters.',
  '- subKey: empty string ("") when the PDF is a single record (most cases). Only when splitting a composite PDF, use the section heading verbatim — and then keep it SHORT (≤60 chars, the heading text only, no descriptions or coordinates).',
  '- headingAnchor: same as subKey. Empty when the PDF has only one record.',
  '- pageStart/pageEnd: inclusive page range (use the "=== PAGE N ===" markers in the input).',
  "- locationLabel: required for 'facility', optional for 'area', null for 'advisory'.",
  '- distance: safety distance / wide-berth radius in METRES. Convert from any unit (1 nautical mile = 1852m, 1 cable = 185.2m, 1 foot = 0.3048m). Use null when the notice does not state a berth requirement — most enclosed-polygon area notices have no extra berth and should be null.',
  '- depth: depth of the hazard itself in METRES (e.g. how deep a wreck sits). Convert from feet (×0.3048) or fathoms (×1.8288). Use null when not stated, or when the number is an operational draught limit rather than a hazard depth.',
  '- geometryParts: for kind=\'area\', list every distinct drawable geometry inside the record. Do NOT extract coordinates. Use pointLabels from the table (e.g. A-E => ["A","B","C","D","E"]; W-Z => ["W","X","Y","Z"]). If a single position has no table point label, use an empty pointLabels array. Use geometryType=\'line\' for cables, curtains, routes, and two-point segments; \'polygon\' for enclosed/bounded areas; \'point\' for a single hazard position. Empty array for facility/advisory.',
  '- Dates in ISO 8601. activeTo is null when there is no expiry. For one-day events or works with a stated event date, activeFrom and activeTo must both be that date.',
].join('\n');

export async function callOutline(
  url: string,
  openai: OpenAI,
  pdfText: string,
): Promise<OutlineRecord[]> {
  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          'Extract the records from the following Notice to Mariners PDF text.\n\n' +
          pdfText,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'parsed_notices_outline',
        strict: true,
        schema: OUTLINE_SCHEMA,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error(`Empty LLM outline response for ${url}`);
  const parsed = JSON.parse(raw) as { notices: OutlineRecord[] };

  if (parsed.notices.length === 0) {
    throw new Error(`LLM returned zero notices for ${url}`);
  }

  // Single-record PDFs don't need a subKey — the prompt asks for "" but the
  // model occasionally emits a verbose section description anyway. Coerce it
  // here so the DB row stays clean and headingAnchor (used for coord
  // attribution) doesn't try to match a heading that won't exist as a line.
  if (parsed.notices.length === 1) {
    parsed.notices[0].subKey = '';
    parsed.notices[0].headingAnchor = '';
  }

  // Reject duplicate subKeys within a single PDF — the unique(source, subKey)
  // index would block the insert anyway, and surfacing it here gives a clearer
  // error than a Postgres constraint violation mid-batch.
  const seen = new Set<string>();
  for (const n of parsed.notices) {
    if (seen.has(n.subKey)) {
      throw new Error(`LLM returned duplicate subKey '${n.subKey}' for ${url}`);
    }
    seen.add(n.subKey);
  }
  if (parsed.notices.length > 1 && seen.has('')) {
    throw new Error(
      `LLM returned an empty subKey alongside other records for ${url}`,
    );
  }

  return parsed.notices;
}
