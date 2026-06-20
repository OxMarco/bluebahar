// Extracts a validity window from a community-map placemark's description.
//
// These are FACTS (dates), not the description's copyrightable expression, so
// reading them is fine even though we never store the prose itself. The
// seasonal swimmer-zone notices state a start date in plain English, e.g.
// "These restrictions are in place from the 9th of April 2026." Standing
// designations (wrecks, archaeological zones) say "all year round" and yield no
// dates — the caller then treats them as permanent.
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
