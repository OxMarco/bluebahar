import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { fetchBuffer, fetchHtml } from '../../common/utils/http';
import { NoticeKind } from '../notice-kind';

export interface ParsedNotice {
  kind: NoticeKind;
  title: string;
  description: string;
  source: string;
  // Required for kind='facility', optional context for 'area', absent for 'advisory'.
  locationLabel?: string;
  publishedAt: Date;
  activeFrom: Date;
  activeTo?: Date;
  area: { lat: number; long: number; depth?: number; distance?: number }[];
  // Set when LLM-extracted coordinates fail geo-sanity checks (outside Malta region
  // or inside Malta land). Flagged notices are persisted but hidden from public getters.
  needsReview: boolean;
}

export interface PdfLink {
  url: string;
  title: string;
  // Listing page the link was discovered on (one of SOURCES).
  source: string;
}

export const SOURCES: string[] = [
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners-93',
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners/local-notice-to-mariners-2336',
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners/port-notices-2337',
];

function isPdfLink(url: URL): boolean {
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return true;
  // Transport Malta serves PDFs via /include/filestreaming.asp?fileid=NNNNN
  if (
    pathname.endsWith('/filestreaming.asp') &&
    url.searchParams.has('fileid')
  ) {
    return true;
  }
  return false;
}

// data-expiredon is rendered as DD/MM/YYYY (or empty for never-expires).
function parseExpiry(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  const year = +m[3];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject silent JS rollover (e.g. 31/02/2026 → 03/03/2026).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function isActive(expiredOnAttr: string | undefined, now: Date): boolean {
  const raw = (expiredOnAttr ?? '').trim();
  if (raw === '') return true; // never-expires
  const expiry = parseExpiry(raw);
  if (!expiry) return true; // unparseable → don't drop, let it through
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return expiry.getTime() >= today.getTime();
}

function extractPdfLinks(
  html: string,
  base: string,
  now: Date = new Date(),
): PdfLink[] {
  const $ = cheerio.load(html);
  const baseUrl = new URL(base);
  const seen = new Map<string, PdfLink>();

  $('ul#noticeslist > li').each((_, li) => {
    if (!isActive($(li).attr('data-expiredon'), now)) return;

    $(li)
      .find('a[href]')
      .each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        let url: URL;
        try {
          url = new URL(href, baseUrl);
        } catch {
          return;
        }

        if (!isPdfLink(url)) return;

        const absolute = url.toString();
        const title = ($(el).attr('title') || $(el).text() || '').trim();
        if (!seen.has(absolute)) {
          seen.set(absolute, { url: absolute, title, source: base });
        }
      });
  });

  return [...seen.values()];
}

async function fetchSource(source: string): Promise<PdfLink[]> {
  const html = await fetchHtml(source);
  return extractPdfLinks(html, source);
}

// Generous Malta maritime region. Anything outside is almost certainly an LLM
// error (sign flip, swapped lat/long, decimal-place mistake, DMS miscalc).
const MALTA_REGION_BBOX = {
  minLat: 35.5,
  maxLat: 36.5,
  minLong: 13.5,
  maxLong: 15.0,
} as const;

// Conservative inland polygons (well inside the actual coastline) for Malta and
// Gozo. Coordinates are [long, lat]. The intent is "obvious land" — coastal
// points stay in the water bucket so we don't flag valid harbour/wreck notices.
const MALTA_LAND_POLYGONS: [number, number][][] = [
  [
    [14.4, 35.93],
    [14.49, 35.93],
    [14.51, 35.89],
    [14.49, 35.85],
    [14.42, 35.84],
    [14.36, 35.86],
    [14.35, 35.89],
    [14.36, 35.92],
    [14.4, 35.93],
  ],
  [
    [14.25, 36.06],
    [14.3, 36.05],
    [14.3, 36.03],
    [14.26, 36.03],
    [14.23, 36.04],
    [14.25, 36.06],
  ],
];

function pointInRing(
  lng: number,
  lat: number,
  ring: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function validateAreaCoordinates(
  area: { lat: number; long: number }[],
): string[] {
  const errors: string[] = [];
  for (const { lat, long } of area) {
    if (
      lat < MALTA_REGION_BBOX.minLat ||
      lat > MALTA_REGION_BBOX.maxLat ||
      long < MALTA_REGION_BBOX.minLong ||
      long > MALTA_REGION_BBOX.maxLong
    ) {
      errors.push(
        `(${lat}, ${long}) is outside the Malta maritime region — check N/S/E/W signs and that lat/long are not swapped`,
      );
      continue;
    }
    if (MALTA_LAND_POLYGONS.some((ring) => pointInRing(long, lat, ring))) {
      errors.push(
        `(${lat}, ${long}) falls on Maltese land — re-check the source coordinates`,
      );
    }
  }
  return errors;
}

// OpenAI structured outputs require every property to appear in `required`;
// optional fields are modelled as nullable and normalized to `undefined` after parse.
const PARSED_NOTICE_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['area', 'facility', 'advisory'],
      description:
        "'area' = notice references one or more lat/long coordinates; " +
        "'facility' = notice concerns a named place (berth, channel, port) without coordinates; " +
        "'advisory' = general guidance with no specific location.",
    },
    title: { type: 'string' },
    description: { type: 'string' },
    locationLabel: {
      type: ['string', 'null'],
      description:
        "Required for 'facility' (e.g. 'Berth 12, Grand Harbour'); " +
        "optional context for 'area' (e.g. 'approach to Valletta'); null for 'advisory'.",
    },
    publishedAt: { type: 'string', description: 'ISO 8601 date' },
    activeFrom: { type: 'string', description: 'ISO 8601 date' },
    activeTo: {
      type: ['string', 'null'],
      description: 'ISO 8601 date, null if the notice has no expiry',
    },
    area: {
      type: 'array',
      description: "Empty array for kind='facility' or 'advisory'.",
      items: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          long: { type: 'number' },
          depth: {
            type: ['number', 'null'],
            description: 'Metres, null if unspecified',
          },
          distance: {
            type: ['number', 'null'],
            description: 'Radius in metres, null if unspecified',
          },
        },
        required: ['lat', 'long', 'depth', 'distance'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'kind',
    'title',
    'description',
    'locationLabel',
    'publishedAt',
    'activeFrom',
    'activeTo',
    'area',
  ],
  additionalProperties: false,
} as const;

type RawParsedNotice = {
  kind: NoticeKind;
  title: string;
  description: string;
  locationLabel: string | null;
  publishedAt: string;
  activeFrom: string;
  activeTo: string | null;
  area: {
    lat: number;
    long: number;
    depth: number | null;
    distance: number | null;
  }[];
};

async function callExtractor(
  url: string,
  openai: OpenAI,
  fileData: string,
  filename: string,
  retryFeedback?: string,
): Promise<RawParsedNotice> {
  const systemPrompt =
    'You extract structured data from Maltese maritime "Notice to Mariners" PDFs.\n' +
    'Classify each notice into one of three kinds:\n' +
    "- 'area': references one or more geographic coordinates (lat/long).\n" +
    "- 'facility': concerns a named place without coordinates (berth, lock, channel, port).\n" +
    '- \'advisory\': general guidance with no specific location (e.g. "max speed in harbours is 10 knots").\n' +
    'For "area" kind, return every coordinate as {lat, long, depth, distance}; ' +
    "convert DMS (e.g. 35°54'N 14°31'E) to decimal degrees with negative values for S/W; " +
    'depth must be expressed in metres below sea level; distance is the safety/radius and must be expressed in metres around the coordinate; ' +
    'use null for depth/distance when not specified. ' +
    'For "facility" and "advisory" kinds, return an empty area array. ' +
    'locationLabel is required for "facility", optional for "area", and null for "advisory". ' +
    'Return ISO8601 dates. activeTo is null when the notice has no expiry date.';

  const userText = retryFeedback
    ? `Extract the Notice to Mariners data from this PDF. A previous extraction failed validation: ${retryFeedback}. Re-read the PDF carefully — pay attention to N/S/E/W signs, DMS-to-decimal conversion, and that lat and long are not swapped.`
    : 'Extract the Notice to Mariners data from this PDF.';

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'file', file: { filename, file_data: fileData } },
          { type: 'text', text: userText },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'parsed_notice',
        strict: true,
        schema: PARSED_NOTICE_SCHEMA,
      },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error(`Empty LLM response for ${url}`);
  return JSON.parse(raw) as RawParsedNotice;
}

export async function extractNoticeFromPdf(
  url: string,
  openai: OpenAI,
): Promise<ParsedNotice> {
  const buffer = await fetchBuffer(url);
  const fileData = `data:application/pdf;base64,${buffer.toString('base64')}`;
  const filename = `${new URL(url).searchParams.get('fileid') ?? 'notice'}.pdf`;

  let parsed = await callExtractor(url, openai, fileData, filename);
  let errors = validateAreaCoordinates(parsed.area);

  // One bounded retry — repeated retries don't tend to recover; beyond a single
  // pass we route the notice to manual review instead of looping.
  if (errors.length > 0) {
    parsed = await callExtractor(
      url,
      openai,
      fileData,
      filename,
      errors.join('; '),
    );
    errors = validateAreaCoordinates(parsed.area);
  }

  return {
    kind: parsed.kind,
    title: parsed.title,
    description: parsed.description,
    source: url,
    ...(parsed.locationLabel !== null && {
      locationLabel: parsed.locationLabel,
    }),
    publishedAt: new Date(parsed.publishedAt),
    activeFrom: new Date(parsed.activeFrom),
    ...(parsed.activeTo !== null && { activeTo: new Date(parsed.activeTo) }),
    area: parsed.area.map((a) => ({
      lat: a.lat,
      long: a.long,
      ...(a.depth !== null && { depth: a.depth }),
      ...(a.distance !== null && { distance: a.distance }),
    })),
    needsReview: errors.length > 0,
  };
}

/**
 * Discover all currently-active PDF links across the configured listing pages.
 * Deduplicates by URL. Intended to be called by the scheduler/orchestrator,
 * which then enqueues one extraction job per returned link.
 */
export async function listNoticeLinks(): Promise<PdfLink[]> {
  const sourceResults = await Promise.allSettled(SOURCES.map(fetchSource));

  const links: PdfLink[] = [];
  for (const result of sourceResults) {
    if (result.status === 'fulfilled') {
      links.push(...result.value);
    }
  }

  const deduped = new Map<string, PdfLink>();
  for (const link of links) deduped.set(link.url, link);
  return [...deduped.values()];
}
