// AI-vision cross-check of the deterministic geometry against the notice's
// own chart pages. Transport Malta notices attach a vector chart that depicts
// the authoritative shape of every zone; the text pipeline occasionally gets
// the TOPOLOGY wrong (zones merged into one ring, a boundary closed on the
// wrong side of a line, a sector flattened to points) even when every
// coordinate is read correctly.
//
// This step renders the chart pages (pdf-parse, in-process — no external
// rasteriser), shows them to a vision model alongside the extracted shapes,
// and asks ONE question: do these depict the same zones? A mismatch flags the
// notice for manual review via the existing needsReview queue. The model never
// produces coordinates and nothing it returns is plotted — geometry stays
// deterministic per the pipeline's core rule (see extract.ts).
import OpenAI from 'openai';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import type { FeatureCollection, Geometry } from 'geojson';
import type { NoticeExtraction } from './types';

export type VisionVerdict = z.infer<typeof VISION_OUTPUT_SCHEMA>;

const VISION_OUTPUT_SCHEMA = z
  .object({
    verdict: z
      .enum(['match', 'mismatch', 'unverifiable'])
      .describe(
        'match = the extracted shapes plausibly depict the same zones as the chart (count, shape type, arrangement, rough position). ' +
          'mismatch = the chart clearly shows something else (different number of zones, merged/split areas, a boundary that should follow the coastline, a wedge/circle drawn as points, shapes on the wrong side of a line). ' +
          'unverifiable = the supplied pages contain no usable chart or the chart does not depict the extracted areas.',
      ),
    discrepancies: z
      .array(z.string())
      .describe(
        'For a mismatch: one short, specific entry per problem, naming the affected zone/label (e.g. "chart shows 7 separate boxes A–N but extraction has one 30-point polygon"). Empty otherwise.',
      ),
    summary: z
      .string()
      .describe(
        'One sentence on what the chart shows and how the extraction compares.',
      ),
  })
  .strict();

function toOpenAiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const VISION_SCHEMA = toOpenAiSchema(VISION_OUTPUT_SCHEMA);

const SYSTEM = [
  'You verify geometry extracted from Transport Malta Notices to Mariners for a chart-plotting app.',
  'You receive rendered pages of the notice PDF (its chart/figure attachments) and the shapes extracted deterministically from the notice text, as labelled coordinate lists.',
  'Compare TOPOLOGY, not decimals: number of distinct zones, shape type (line / polygon / circle / sector wedge), whether zones are separate or merged, whether a boundary follows the coastline, and rough placement using the chart’s latitude/longitude graticule.',
  'The coordinates come from the notice’s own table and are authoritative for position; never propose corrected coordinates.',
  'Report only what the chart clearly contradicts.',
].join(' ');

const DEFAULT_VISION_MODEL = (): string =>
  process.env.VISION_MODEL ||
  process.env.ENRICH_MODEL ||
  process.env.OPENAI_MODEL ||
  'gpt-5.5';

// Pages worth rendering: everything after page 1 (the letter text) whose text
// layer is sparse — vector charts carry only coordinate labels — and which is
// not a boilerplate disclaimer page. Capped: a 29-page notice with one chart
// per zone still verifies, just partially.
const MAX_CHART_PAGES = 5;
const SPARSE_TEXT_CHARS = 600;

export async function renderChartPages(
  buffer: Buffer | Uint8Array,
): Promise<string[]> {
  const parser = new PDFParse({
    data: buffer instanceof Buffer ? new Uint8Array(buffer) : buffer,
  });
  try {
    const { total } = await parser.getInfo();
    const candidates: number[] = [];
    for (let n = 2; n <= total && candidates.length < MAX_CHART_PAGES; n++) {
      const { text } = await parser.getText({ partial: [n] });
      const dense = text.replace(/\s/g, '').length;
      if (dense >= SPARSE_TEXT_CHARS) continue;
      if (/DISCLAIMER/i.test(text)) continue;
      candidates.push(n);
    }
    if (!candidates.length) return [];
    const shots = await parser.getScreenshot({
      partial: candidates,
      scale: 1.5,
    });
    return shots.pages.map((p) => p.dataUrl);
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// Compact, deterministic description of what the pipeline extracted — the
// "other side" of the comparison the model is asked to make.
export function describeExtraction(
  extraction: NoticeExtraction,
  featureCollection: FeatureCollection<Geometry | null>,
): string {
  const lines: string[] = [];
  extraction.areas.forEach((area, i) => {
    const realised = featureCollection.features[i]?.geometry?.type ?? 'none';
    const pts = area.points
      .map((p) => `${p.label} ${p.lat.toFixed(5)}N ${p.lon.toFixed(5)}E`)
      .join('; ');
    lines.push(
      `${i + 1}. "${area.name}" — ${area.geometry_kind}${
        area.radius_nm ? ` radius ${area.radius_nm} NM` : ''
      } (rendered as ${realised}) — points: ${pts || 'none'}`,
    );
  });
  return lines.join('\n');
}

// True when the notice carries geometry whose topology was inferred and is
// therefore worth a vision pass: any multi-point shape, circle or sector. A
// notice of bare points restates its own table and has nothing to verify.
export function hasVerifiableGeometry(extraction: NoticeExtraction): boolean {
  return extraction.areas.some(
    (a) =>
      a.points.length >= 2 ||
      a.geometry_kind === 'circle' ||
      a.geometry_kind === 'sector',
  );
}

export async function verifyExtractionWithVision(
  client: OpenAI,
  buffer: Buffer | Uint8Array,
  extraction: NoticeExtraction,
  featureCollection: FeatureCollection<Geometry | null>,
  model?: string,
): Promise<VisionVerdict> {
  const pages = await renderChartPages(buffer);
  if (!pages.length) {
    return {
      verdict: 'unverifiable',
      discrepancies: [],
      summary: 'No chart pages found in the PDF.',
    };
  }

  const context = [
    `Notice: ${extraction.title ?? extraction.source_file}`,
    '',
    'Shapes extracted from the notice text:',
    describeExtraction(extraction, featureCollection),
    '',
    'The attached images are the notice’s chart pages. Do they depict the same zones?',
  ].join('\n');

  const response = await client.responses.create(
    {
      model: model || DEFAULT_VISION_MODEL(),
      input: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: context },
            ...pages.map((dataUrl) => ({
              type: 'input_image' as const,
              image_url: dataUrl,
              detail: 'high' as const,
            })),
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'ntm_vision_verdict',
          strict: true,
          schema: VISION_SCHEMA,
        },
      },
    },
    // Same rationale as enrich.ts: the worker runs with concurrency 1, so a
    // hung call would stall the queue. Verification is best-effort.
    { timeout: 90_000, maxRetries: 1 },
  );

  const jsonText = response.output_text;
  if (!jsonText) throw new Error('empty vision verification output');
  return VISION_OUTPUT_SCHEMA.parse(JSON.parse(jsonText));
}
