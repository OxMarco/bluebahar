// Shared building blocks for the deterministic text reader, vendored from the
// mariner-parser project (bench/core.ts). Coordinates, metadata, dates and the
// document-type classifier all come from here — no LLM touches the numbers.
import fs from 'node:fs/promises';
import path from 'node:path';
import { LRUCache } from 'lru-cache';
import { PDFParse } from 'pdf-parse';
import type { DocumentType, ResolvedPoint } from './types';

export const MALTA_BBOX = {
  minLat: 35.6,
  maxLat: 36.25,
  minLon: 14.0,
  maxLon: 14.8,
};

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type PdfText = { text: string; pages: number };

function cacheSizeEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const PDF_TEXT_CACHE_SIZE = cacheSizeEnv(process.env.PDF_TEXT_CACHE_SIZE, 64);
const pdfTextCache =
  PDF_TEXT_CACHE_SIZE > 0
    ? new LRUCache<string, PdfText>({ max: PDF_TEXT_CACHE_SIZE })
    : null;
const pdfTextInflight = new Map<string, Promise<PdfText>>();

// Read text out of a raw PDF buffer (the shape the scraper has after fetching a
// URL). Not cached — each scrape job streams a fresh buffer.
export async function readPdfTextFromBuffer(
  buffer: Buffer | Uint8Array,
): Promise<PdfText> {
  const parser = new PDFParse({
    data: buffer instanceof Buffer ? new Uint8Array(buffer) : buffer,
  });
  try {
    const pdf = await parser.getText();
    return {
      text: normalizeText(pdf.text),
      pages: (pdf as { pages?: unknown[] }).pages?.length ?? 1,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function pdfCacheKey(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  return `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}`;
}

async function parsePdfText(filePath: string): Promise<PdfText> {
  const buffer = await fs.readFile(filePath);
  return readPdfTextFromBuffer(buffer);
}

// File-based reader (used by offline tests/fixtures). Coalesces concurrent
// reads of the same file and caches the parsed text by path+size+mtime.
export async function readPdfText(filePath: string): Promise<PdfText> {
  const key = await pdfCacheKey(filePath);
  const cached = pdfTextCache?.get(key);
  if (cached) return cached;

  const inflight = pdfTextInflight.get(key);
  if (inflight) return inflight;

  const promise = parsePdfText(filePath)
    .then((value) => {
      pdfTextCache?.set(key, value);
      return value;
    })
    .finally(() => {
      pdfTextInflight.delete(key);
    });
  pdfTextInflight.set(key, promise);
  return promise;
}

export function parseDmm(deg: string, min: string, frac: string): number {
  const minutes = Number(`${min}.${frac.padEnd(3, '0')}`);
  return Number((Number(deg) + minutes / 60).toFixed(8));
}

export function isoDate(
  day: string,
  monthName: string,
  year: string,
): string | null {
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

// A single DMM coordinate ROW: "1A 35° 49'.213 014° 27'.724" (label optional).
const COORD_RE =
  /(?:\b(?<label>\d{1,3}[A-Z])\s+)?(?<latDeg>\d{2})\s*°\s*(?<latMin>\d{2})\s*['′]\s*\.?\s*(?<latFrac>\d{1,3})\s+(?<lonDeg>0?\d{2,3})\s*°\s*(?<lonMin>\d{2})\s*['′]\s*\.?\s*(?<lonFrac>\d{1,3})/g;

export type RawCoord = ResolvedPoint & { raw: string; generatedLabel: boolean };

// Extract every coordinate row, in document order. The regex is the
// ground-truth-grade number reader.
export function extractCoordinates(text: string): RawCoord[] {
  const out: RawCoord[] = [];
  let gen = 1;
  for (const m of text.matchAll(COORD_RE)) {
    const g = m.groups!;
    out.push({
      label: g.label ?? `P${gen++}`,
      lat: parseDmm(g.latDeg, g.latMin, g.latFrac),
      lon: parseDmm(g.lonDeg, g.lonMin, g.lonFrac),
      raw: m[0].trim(),
      generatedLabel: !g.label,
    });
  }
  return out;
}

export function resolveLabels<T extends ResolvedPoint>(
  labels: string[],
  byLabel: Map<string, T>,
): ResolvedPoint[] {
  return labels
    .map((l) => byLabel.get(l))
    .filter((p): p is T => Boolean(p))
    .map((p) => ({ label: p.label, lat: p.lat, lon: p.lon }));
}

export function inBbox(p: { lat: number; lon: number }): boolean {
  return (
    p.lat >= MALTA_BBOX.minLat &&
    p.lat <= MALTA_BBOX.maxLat &&
    p.lon >= MALTA_BBOX.minLon &&
    p.lon <= MALTA_BBOX.maxLon
  );
}

export type NoticeMeta = {
  notice_no: string | null;
  notice_year: string | null;
  date: string | null;
  title: string | null;
  charts_affected: string[];
  referenced_notices: string[];
};

export function extractMetadata(text: string): NoticeMeta {
  const noticeMatch = text.match(
    /NOTICE\S*\s+TO\s+MARINERS\s+N[ºo°]?\s*(\d+)\s+of\s+(\d{4})/i,
  );
  const dateMatch = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
  );
  const date = dateMatch
    ? isoDate(dateMatch[1], dateMatch[2], dateMatch[3])
    : null;

  const chartsLine = text.match(/Charts?\s+[Aa]ffected\s*:\s*([^\n]+)/i);
  const charts_affected = chartsLine
    ? chartsLine[1]
        .split(/,|\s{2,}|\sand\s/)
        .map((s) => s.trim().replace(/[.;]+$/, ''))
        .filter(Boolean)
    : [];

  const self = noticeMatch ? `${noticeMatch[1]}/${noticeMatch[2]}` : null;
  const referenced_notices = Array.from(
    text.matchAll(/Notice\s+to\s+Mariners\s+N[ºo°]?\s*(\d+)\s+of\s+(\d{4})/gi),
    (m) => `${m[1]}/${m[2]}`,
  ).filter((v, i, arr) => arr.indexOf(v) === i && v !== self);

  let title: string | null = null;
  if (dateMatch?.index !== undefined) {
    const afterDate = text
      .slice(dateMatch.index + dateMatch[0].length)
      .split('\n');
    title =
      afterDate
        .map((s) => s.trim())
        .find(
          (line) =>
            line.length > 8 &&
            !/^The Ports and Yachting Directorate/i.test(line) &&
            !/^Reference is made/i.test(line),
        ) ?? null;
  }

  return {
    notice_no: noticeMatch?.[1] ?? null,
    notice_year: noticeMatch?.[2] ?? null,
    date,
    title,
    charts_affected,
    referenced_notices,
  };
}

export function extractValidTo(text: string): string | null {
  const m = text.match(
    /\b(?:until|extended until)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i,
  );
  return m ? isoDate(m[1], m[2], m[3]) : null;
}

// Classifier: a "new_restriction" that merely *cancels* an older notice must
// NOT be classified as a cancellation. We only call it a cancellation when the
// notice's own subject is the cancellation.
export function classifyDocumentType(text: string): DocumentType {
  if (
    /Chart Correction/i.test(text) ||
    /\bInsert:\b[\s\S]*\bDelete:/i.test(text)
  )
    return 'chart_correction';
  if (
    /completion date.*extended|extended until|will not\s+be completed within the time/i.test(
      text,
    )
  )
    return 'time_extension';
  if (
    /^[\s\S]{0,400}\bAmendment to (?:Local )?Notice to Mariners\b/i.test(text)
  )
    return 'amendment';
  const cancelsSelf = /This Notice .* is hereby CANCELLED/i.test(text);
  if (cancelsSelf) return 'cancellation';
  if (
    /restricted area|restriction areas|No anchoring|No navigation|Maximum speed|prohibited|Transit Prohibited/i.test(
      text,
    )
  )
    return 'new_restriction';
  if (
    /(?:live\s+)?firing\s+practice|exercise area|keep,?\s*as a minimum|are restricted to both vessels/i.test(
      text,
    )
  )
    return 'new_restriction';
  if (/navigate with caution|yellow flashing buoys|floating line/i.test(text))
    return 'new_restriction';
  return 'unknown';
}

export function inferHazardType(text: string): string {
  if (/UXO/i.test(text)) return 'uxo_survey';
  if (/submarine power cable/i.test(text)) return 'submarine_power_cable';
  if (/swimmer/i.test(text)) return 'swimmer_zone';
  if (/minimum distance .*cliff/i.test(text)) return 'coastal_buffer';
  if (/No navigation/i.test(text)) return 'no_navigation';
  if (/No anchoring/i.test(text)) return 'no_anchoring';
  if (/Maximum speed/i.test(text)) return 'speed_restriction';
  if (/compulsory lights? and sounds?/i.test(text))
    return 'lights_sounds_restriction';
  if (/restricted area/i.test(text)) return 'restricted_area';
  return 'unknown';
}

export function basename(p: string): string {
  return path.basename(p);
}
