// AI enrichment step — the ONE place an LLM is used in the production pipeline.
// Vendored from the mariner-parser project (src/enrich.ts) and refactored to
// accept the scraper's shared OpenAI client (rather than constructing its own).
//
// It never touches coordinates or geometry (regex owns those, deterministically).
// It does only what an LLM is genuinely better at: triage the notice into a
// category and write a short plain-language summary, recommended action,
// affected place names, and a human-readable validity window. One call, strict
// JSON schema.
import OpenAI from 'openai';
import { z } from 'zod';
import type { NoticeExtraction } from './types';

const NOTICE_CATEGORIES = ['alert', 'info', 'other'] as const;

export type Enrichment = z.infer<typeof ENRICH_OUTPUT_SCHEMA>;

// Single source of truth for the enrichment shape: the zod schema carries the
// field descriptions (which steer the LLM) and both validates the response and
// generates the OpenAI request schema below — so the two can never drift.
const ENRICH_OUTPUT_SCHEMA = z
  .object({
    category: z
      .enum(NOTICE_CATEGORIES)
      .describe(
        'Classify by the SUBSTANCE of what the notice describes, never by its document type — a "chart correction" can be either. ' +
          'alert = there is an area to avoid or to navigate with care: a lost/dragging anchor, a newly laid cable or pipeline, a new or moved buoy/mark, a wreck or obstruction, diving or survey operations, fireworks, a firing/gunnery range, a prohibited or restricted area, or any active danger. ' +
          'info = administrative or non-hazard navigational information: changes to navigation lights, VHF/radio channels or working frequencies, harbour layout/configuration, cumulative lists, amendments, or cancellations. ' +
          'other = neither.',
      ),
    summary: z.string().describe('One or two short, plain-language sentences.'),
    recommended_action: z
      .string()
      .describe(
        'A single imperative line for a mariner, or empty string if none.',
      ),
    affected_locations: z
      .array(z.string())
      .describe(
        'Named places mentioned (bays, headlands, harbours, ranges). Empty array if none.',
      ),
    validity: z
      .string()
      .describe(
        "Active period in prose if stated (e.g. '8 June 2026, 16:30-18:00' or 'all year round'), else empty string.",
      ),
  })
  .strict();

// OpenAI strict structured-output schema, generated from the zod schema. Strip
// the `$schema` annotation that the API's strict validator rejects.
function toOpenAiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const ENRICH_SCHEMA = toOpenAiSchema(ENRICH_OUTPUT_SCHEMA);

const SYSTEM = [
  'You triage Transport Malta Notices to Mariners for a chart-plotting app.',
  'Return ONLY the structured fields. Never invent, transcribe, or alter coordinates, chart numbers, or dates — those are extracted separately.',
  'Base every field strictly on the notice text provided.',
].join(' ');

// Fallback chain for standalone (CLI/fixture) runs; the production processor
// passes the model explicitly from the validated config schema.
const DEFAULT_ENRICH_MODEL = (): string =>
  process.env.ENRICH_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';

// Compact context: the rule-based extraction + the notice text
function buildContext(text: string, x: NoticeExtraction): string {
  return [
    `Title: ${x.title ?? ''}`,
    `Rule-based document type: ${x.document_type}`,
    `Extracted areas: ${
      x.areas
        .map((a) => a.name)
        .filter(Boolean)
        .join('; ') || 'none'
    }`,
    `Charts affected: ${x.charts_affected.join(', ') || 'none'}`,
    `Dates: from ${x.valid_from ?? '?'} to ${x.valid_to ?? '?'}`,
    '--- NOTICE TEXT ---',
    text,
  ].join('\n');
}

export async function enrichNotice(
  client: OpenAI,
  text: string,
  extraction: NoticeExtraction,
  model?: string,
): Promise<Enrichment> {
  const response = await client.responses.create(
    {
      model: model || DEFAULT_ENRICH_MODEL(),
      input: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildContext(text, extraction) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'ntm_enrichment',
          strict: true,
          schema: ENRICH_SCHEMA,
        },
      },
    },
    // The worker runs with concurrency 1, so a hung call (SDK default timeout
    // is 10 minutes) would stall the whole queue. Enrichment is best-effort;
    // fail fast and let the caller fall back to the rule-based description.
    { timeout: 60_000, maxRetries: 1 },
  );

  const jsonText = response.output_text;
  if (!jsonText) throw new Error('empty enrichment output');
  return ENRICH_OUTPUT_SCHEMA.parse(JSON.parse(jsonText));
}
