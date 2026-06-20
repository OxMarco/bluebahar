// Extracts the FACTS a community-map placemark states — validity window, the
// establishing notice reference, the official source link, and any safety
// distance. These are facts/links, not the description's copyrightable
// expression, so reading (and storing) them is fine even though we never keep
// the prose itself. The seasonal swimmer-zone notices state a start date in
// plain English, e.g. "These restrictions are in place from the 9th of April
// 2026." Standing designations (wrecks, archaeological zones) say "all year
// round" and yield no validity dates — the caller then dates them from the
// notice year instead.
import { DateTime } from 'luxon';

export interface Validity {
  from?: Date;
  to?: Date;
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

// "9th of April 2026" / "9 April 2026" -> a UTC instant. `endOfDay` anchors an
// end date to 23:59:59.999 so an inclusive "until 30 September" stays valid for
// the whole of that day (matches the adapter's activeTo handling).
function toDate(
  day: string,
  month: string,
  year: string,
  endOfDay = false,
): Date | null {
  const m = MONTHS[month.toLowerCase()];
  const d = Number(day);
  const y = Number(year);
  if (!m || !Number.isFinite(d) || !Number.isFinite(y)) return null;
  const dt = DateTime.utc(y, m, d);
  if (!dt.isValid) return null;
  return (endOfDay ? dt.endOf('day') : dt).toJSDate();
}

// `<day> [of] <month> <year>`, optional ordinal suffix. Month is a name so a
// bare numeric date can't be misread.
const DATE = String.raw`(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]+)\s+(\d{4})`;
const FROM_RE = new RegExp(
  String.raw`(?:in place|effective|valid|applicable|enforced)[^.]*?\bfrom(?:\s+the)?\s+${DATE}`,
  'i',
);
const TO_RE = new RegExp(
  String.raw`(?:until|till|up to|to)(?:\s+the)?\s+${DATE}`,
  'i',
);

// The notice that established a zone names its issue year, e.g. "Notice to
// Mariners 09 & 10 of 2023", "Notice to Mariners 059 of 2026", or "Local Notice
// to Mariners No. 132 of 2025". Standing ("all year round") designations state
// no start date in their prose; their notice year is the most faithful
// activeFrom we have — far better than the day we happened to scrape the map.
// The reference lives in the placemark description (swimmer zones) or, for the
// permanent layers, only in the KML folder label. We read only the year (a
// fact); we never store the label's prose. The bounded `.{0,40}?` lets the
// match cross the "No." abbreviation without running into a later sentence.
const NOTICE_YEAR_RE = /notices? to mariners\b.{0,40}?\bof\s+(\d{4})/i;

// Jan 1 (UTC) of the year named in a notice-to-mariners reference, or null when
// no plausible reference is present.
export function parseNoticeDate(text: string | undefined | null): Date | null {
  if (!text) return null;
  const m = NOTICE_YEAR_RE.exec(text.replace(/<[^>]+>/g, ' '));
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 2000 || year > 2100) return null;
  return DateTime.utc(year, 1, 1).toJSDate();
}

export function parseValidity(
  description: string | undefined | null,
): Validity {
  if (!description) return {};
  // Descriptions arrive as HTML (CDATA with <br>, links). Strip tags so the
  // date phrasing reads as continuous prose.
  const text = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const out: Validity = {};
  const from = FROM_RE.exec(text);
  if (from) {
    const d = toDate(from[1], from[2], from[3]);
    if (d) out.from = d;
  }
  const to = TO_RE.exec(text);
  if (to) {
    const d = toDate(to[1], to[2], to[3], true);
    if (d) out.to = d;
  }
  return out;
}

// Strip HTML/CDATA tags and collapse whitespace, so a reference or link split
// across <br>/<b> reads as continuous prose. Shared by the fact extractors.
function plain(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

// The full establishing reference, e.g. "Notice to Mariners 09 & 10 of 2023" or
// "Local Notice to Mariners No. 132 of 2025". Stored verbatim for provenance.
const NOTICE_REF_RE =
  /(?:local\s+)?notices? to mariners\b.{0,40}?\bof\s+\d{4}/i;
export function parseNoticeRef(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = NOTICE_REF_RE.exec(plain(text));
  return m ? m[0].trim() : null;
}

// The official source link (Transport Malta filestream, legislation.mt, …).
// The first http(s) URL in the description; trailing sentence punctuation is
// trimmed so the stored link is clean.
const URL_RE = /https?:\/\/[^\s"'<>]+/i;
export function parseSourceUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = URL_RE.exec(plain(text));
  return m ? m[0].replace(/[.,;)]+$/, '') : null;
}

// Safety berth radius in metres, e.g. "maintain a minimum distance of 100m".
// Anchored on "distance of <n>" so a stray number (speed, channel) can't be
// misread as a distance.
const DISTANCE_RE = /distance of\s+(\d+(?:\.\d+)?)\s*(?:m\b|metres|meters)/i;
const DISTANCE_NM_RE =
  /(?:distance|zone) of\s+(\d+(?:\.\d+)?)\s*(?:nm\b|nautical miles?)/i;
export function parseDistance(text: string | undefined | null): number | null {
  if (!text) return null;
  const source = plain(text);
  const metres = DISTANCE_RE.exec(source);
  const nauticalMiles = DISTANCE_NM_RE.exec(source);
  const amount = Number((metres ?? nauticalMiles)?.[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return nauticalMiles ? amount * 1852 : amount;
}
