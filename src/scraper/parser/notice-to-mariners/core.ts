// Shared building blocks for the deterministic text reader, vendored from the
// mariner-parser project (bench/core.ts). Coordinates, metadata, dates and the
// document-type classifier all come from here — no LLM touches the numbers.
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { DateTime } from 'luxon';
import type { DocumentType, ResolvedPoint } from './types';

const MALTA_BBOX = {
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
const MONTH_PATTERN = Object.keys(MONTHS)
  .map((m) => `${m[0].toUpperCase()}${m.slice(1)}`)
  .join('|');
const WEEKDAY_PATTERN =
  '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+';
const NOTICE_DATE_PATTERN = `(?:${WEEKDAY_PATTERN})?(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\s+(\\d{4})`;
const NOTICE_TIME_ZONE = 'Europe/Malta';

function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\uF0B0/g, '°')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type PdfText = { text: string; pages: number };

// Read text out of a raw PDF buffer (the shape the scraper has after fetching a
// URL). Each scrape job streams a fresh buffer.
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

export function parseDmm(deg: string, min: string, frac: string): number {
  const minutes = Number(`${min}.${frac.padEnd(3, '0')}`);
  return Number((Number(deg) + minutes / 60).toFixed(8));
}

function isoDate(day: string, monthName: string, year: string): string | null {
  const month = MONTHS[monthName.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

function isoFromMatch(match: RegExpMatchArray, offset = 1): string | null {
  return isoDate(match[offset], match[offset + 1], match[offset + 2]);
}

function parseClock(raw: string): { hour: number; minute: number } | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 1 || digits.length > 4) return null;
  const hourPart = digits.length <= 2 ? digits : digits.slice(0, -2);
  const minutePart = digits.length <= 2 ? '00' : digits.slice(-2);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// Interpret a notice's local date + clock time in Malta's timezone and return
// the corresponding UTC instant as an ISO string. luxon resolves the DST offset
// (including spring-forward/fall-back) for that wall-clock time.
function localNoticeDateTimeToUtcIso(
  dateIso: string,
  clockRaw: string,
): string | null {
  const clock = parseClock(clockRaw);
  if (!clock) return null;
  const dateParts = dateIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateParts) return null;
  const local = DateTime.fromObject(
    {
      year: Number(dateParts[1]),
      month: Number(dateParts[2]),
      day: Number(dateParts[3]),
      hour: clock.hour,
      minute: clock.minute,
    },
    { zone: NOTICE_TIME_ZONE },
  );
  return local.isValid ? local.toUTC().toJSDate().toISOString() : null;
}

// A single DMM coordinate ROW: "1A 35° 49'.213 014° 27'.724" (label optional).
// Shared so the strict (COORD_RE) and permissive (regex-strategy GEN_ROW)
// coordinate readers, plus the title scanner, use one degree-glyph class.
export const DEGREE_MARK = String.raw`[°º˚\uF0B0]`;
const COORD_RE = new RegExp(
  String.raw`(?:\b(?<label>\d{1,3}[A-Z])\s+)?(?<latDeg>\d{2})\s*${DEGREE_MARK}\s*(?<latMin>\d{2})\s*['′]\s*\.?\s*(?<latFrac>\d{1,3})\s+(?<lonDeg>0?\d{2,3})\s*${DEGREE_MARK}\s*(?<lonMin>\d{2})\s*['′]\s*\.?\s*(?<lonFrac>\d{1,3})`,
  'g',
);
const LOOSE_COORD_RE =
  /\b(?:[A-Z]\d?|\d{1,3}[A-Z])?\.?\s*(3[56])\D{1,12}([0-5]\d)(?:\D{0,4}(\d{1,3}))?\D{1,28}(0?14)\D{1,12}([0-5]\d)(?:\D{0,4}(\d{1,3}))?/g;

export type RawCoord = ResolvedPoint & { raw: string };

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
    });
  }
  return out;
}

// Soft tripwire for parser misses: detects Malta-looking DMM coordinate rows
// even when an unexpected separator/glyph made the strict parser reject them.
// It intentionally does not produce coordinates; callers use it only to avoid
// silently publishing a notice with no map geometry.
export function countPossibleCoordinateRows(text: string): number {
  let count = 0;
  for (const m of text.matchAll(LOOSE_COORD_RE)) {
    const context = text.slice(
      Math.max(0, (m.index ?? 0) - 120),
      Math.min(text.length, (m.index ?? 0) + m[0].length + 120),
    );
    const hasFraction = Boolean(m[3] || m[6]);
    const hasCoordinateContext =
      /\b(?:latitude|longitude|position|coordinates?|wgs|datum)\b/i.test(
        context,
      );
    if (hasFraction || hasCoordinateContext) count++;
  }
  return count;
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

function extractValidTo(text: string): string | null {
  const m = text.match(
    new RegExp(`\\b(?:until|extended until)\\s+${NOTICE_DATE_PATTERN}\\b`, 'i'),
  );
  return m ? isoFromMatch(m) : null;
}

export function extractValidityWindow(
  text: string,
  publicationDate: string | null,
): { validFrom: string | null; validTo: string | null } {
  const dateTime = text.match(
    new RegExp(
      `\\bon\\s+${NOTICE_DATE_PATTERN}[\\s\\S]{0,260}?\\bbetween\\s+([0-9]{1,2}(?::|\\.)?[0-9]{2})\\s*(?:hours?)?\\s+(?:and|to)\\s+([0-9]{1,2}(?::|\\.)?[0-9]{2})\\s*(?:hours?)?`,
      'i',
    ),
  );
  if (dateTime) {
    const date = isoFromMatch(dateTime);
    const start = date ? localNoticeDateTimeToUtcIso(date, dateTime[4]) : null;
    const end = date ? localNoticeDateTimeToUtcIso(date, dateTime[5]) : null;
    if (start && end) return { validFrom: start, validTo: end };
  }

  const fromTo = text.match(
    new RegExp(
      `\\bfrom\\s+${NOTICE_DATE_PATTERN}\\s+(?:to|until)\\s+${NOTICE_DATE_PATTERN}\\b`,
      'i',
    ),
  );
  if (fromTo) {
    return {
      validFrom: isoFromMatch(fromTo),
      validTo: isoFromMatch(fromTo, 4),
    };
  }

  const betweenDates = text.match(
    new RegExp(
      `\\bbetween\\s+${NOTICE_DATE_PATTERN}\\s+and\\s+${NOTICE_DATE_PATTERN}\\b`,
      'i',
    ),
  );
  if (betweenDates) {
    return {
      validFrom: isoFromMatch(betweenDates),
      validTo: isoFromMatch(betweenDates, 4),
    };
  }

  const eventOnDate =
    text.match(
      new RegExp(
        `\\b(?:will\\s+(?:carry\\s+out|take\\s+place|be\\s+held)|shall\\s+take\\s+place|is\\s+scheduled|are\\s+scheduled)[\\s\\S]{0,220}?\\bon\\s+${NOTICE_DATE_PATTERN}\\b`,
        'i',
      ),
    ) ??
    text.match(
      new RegExp(
        `\\b(?:live\\s+firing\\s+practice|exercise|works?)[\\s\\S]{0,220}?\\bon\\s+${NOTICE_DATE_PATTERN}\\b`,
        'i',
      ),
    );
  if (eventOnDate) {
    const date = isoFromMatch(eventOnDate);
    return { validFrom: date, validTo: date };
  }

  return {
    validFrom: publicationDate,
    validTo: extractValidTo(text),
  };
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
