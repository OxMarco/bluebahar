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
import { estimateCost } from './cost';
import type { NoticeExtraction } from './types';

const NOTICE_CATEGORIES = ['alert', 'info', 'other'] as const;

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export type Enrichment = {
  category: NoticeCategory;
  summary: string;
  recommended_action: string; // "" when none
  affected_locations: string[];
  validity: string; // prose active period, "" when none
  model: string;
  latency_ms: number;
  cost_usd: number;
};

const ENRICH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'category',
    'summary',
    'recommended_action',
    'affected_locations',
    'validity',
  ],
  properties: {
    category: {
      type: 'string',
      enum: NOTICE_CATEGORIES,
      description:
        'alert = active hazard/restriction a mariner must act on (firing, restricted/prohibited area, danger); info = informational/administrative (chart corrections, cumulative lists, amendments, cancellations); other = neither.',
    },
    summary: {
      type: 'string',
      description: 'One or two short, plain-language sentences.',
    },
    recommended_action: {
      type: 'string',
      description:
        'A single imperative line for a mariner, or empty string if none.',
    },
    affected_locations: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Named places mentioned (bays, headlands, harbours, ranges). Empty array if none.',
    },
    validity: {
      type: 'string',
      description:
        "Active period in prose if stated (e.g. '8 June 2026, 16:30-18:00' or 'all year round'), else empty string.",
    },
  },
} as const;

const ENRICH_OUTPUT_SCHEMA = z
  .object({
    category: z.enum(NOTICE_CATEGORIES),
    summary: z.string(),
    recommended_action: z.string(),
    affected_locations: z.array(z.string()),
    validity: z.string(),
  })
  .strict();

const SYSTEM = [
  'You triage Transport Malta Notices to Mariners for a chart-plotting app.',
  'Return ONLY the structured fields. Never invent, transcribe, or alter coordinates, chart numbers, or dates — those are extracted separately.',
  'Base every field strictly on the notice text provided.',
].join(' ');

const ENRICH_MODEL = (): string =>
  process.env.ENRICH_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';

// Compact context: the rule-based extraction + the notice text (truncated for cost).
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
    text.slice(0, 12000),
  ].join('\n');
}

export async function enrichNotice(
  client: OpenAI,
  text: string,
  extraction: NoticeExtraction,
): Promise<Enrichment> {
  const model = ENRICH_MODEL();
  const t0 = Date.now();

  const response = await client.responses.create({
    model,
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
  });

  const jsonText = response.output_text;
  if (!jsonText) throw new Error('empty enrichment output');
  const e = ENRICH_OUTPUT_SCHEMA.parse(JSON.parse(jsonText));
  const usage = (
    response as { usage?: { input_tokens?: number; output_tokens?: number } }
  ).usage;
  const inTok = usage?.input_tokens ?? 0;
  const outTok = usage?.output_tokens ?? 0;
  return {
    ...e,
    model,
    latency_ms: Date.now() - t0,
    cost_usd: estimateCost(model, inTok, outTok),
  };
}
