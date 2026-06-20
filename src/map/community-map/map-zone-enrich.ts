import OpenAI from 'openai';
import { z } from 'zod';

const MAP_ZONE_OUTPUT_SCHEMA = z
  .object({
    summary: z
      .string()
      .describe(
        'One or two short, plain-language sentences telling a mariner what this ' +
          'zone is and why it matters. Base it ONLY on the restriction brief and ' +
          'place name provided; do not invent specifics that were not given.',
      ),
    recommended_action: z
      .string()
      .describe(
        'A single imperative line for a mariner, or empty string if none.',
      ),
  })
  .strict();

export type MapZoneEnrichment = z.infer<typeof MAP_ZONE_OUTPUT_SCHEMA>;

const schema = z.toJSONSchema(MAP_ZONE_OUTPUT_SCHEMA) as Record<
  string,
  unknown
>;
delete schema.$schema;

const SYSTEM = [
  'You write short, original descriptions of Maltese marine restriction zones for a chart-plotting app.',
  'You are given only a restriction class and a place name.',
  'Write your own wording from those facts. Never copy phrasing from any source.',
  'Do not invent specifics beyond what the brief states.',
].join(' ');

export interface MapZoneInput {
  category: string;
  zoneName: string;
  restrictionBrief: string;
}

export async function enrichMapZone(
  client: OpenAI,
  input: MapZoneInput,
  model?: string,
): Promise<MapZoneEnrichment> {
  const response = await client.responses.create(
    {
      model:
        model ||
        process.env.ENRICH_MODEL ||
        process.env.OPENAI_MODEL ||
        'gpt-5.5',
      input: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `Restriction class: ${input.category}`,
            `What this class is: ${input.restrictionBrief}`,
            `Place: ${input.zoneName}`,
          ].join('\n'),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'map_zone_description',
          strict: true,
          schema,
        },
      },
    },
    { timeout: 60_000, maxRetries: 1 },
  );

  if (!response.output_text) {
    throw new Error('empty map-zone enrichment output');
  }
  return MAP_ZONE_OUTPUT_SCHEMA.parse(JSON.parse(response.output_text));
}
