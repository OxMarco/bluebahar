// Structural-integrity backstop for ParsedNotice at the DB boundary.
//
// The adapter assembles a ParsedNotice from several branches — deterministic
// regex extraction, the listing-page anchor, and the (Zod-validated) AI
// enrichment. Only the AI branch was ever schema-checked, so a regression in
// the deterministic branches could persist a malformed row unnoticed (this is
// how the "filestreaming.asp?fileid=11606" title reached the DB). This schema
// describes the well-formed shape every record should satisfy, regardless of
// which branch produced each field.
//
// Action on failure: we DOWNGRADE to needsReview rather than reject. A notice
// can be safety-critical, so discarding it (and spinning Bull retries on
// deterministic input) is worse than persisting it hidden from the public
// getters until a human curates it — the same treatment the adapter already
// gives soft content issues like a URL-like title.
import { z } from 'zod';
import { NoticeKind } from '../../notice-kind';
import type { ParsedNotice } from './adapter';

const NoticePointSchema = z.object({
  lat: z.number().finite().gte(-90).lte(90),
  long: z.number().finite().gte(-180).lte(180),
});

const NoticeGeometryPartSchema = z.object({
  label: z.string().min(1),
  geometryType: z.enum(['point', 'line', 'polygon']),
  points: z.array(NoticePointSchema),
});

// new Date('garbage') is still a Date instance, so z.date() alone passes NaN
// timestamps; reject those explicitly.
const validDate = z
  .date()
  .refine((d) => !Number.isNaN(d.getTime()), { message: 'invalid Date' });

const ParsedNoticeSchema = z
  .object({
    kind: z.nativeEnum(NoticeKind),
    title: z.string().trim().min(1),
    description: z.string().min(1),
    source: z.string().min(1),
    subKey: z.string(),
    locationLabel: z.string().min(1).optional(),
    publishedAt: validDate,
    activeFrom: validDate,
    activeTo: validDate.optional(),
    distance: z.number().finite().optional(),
    areas: z.array(NoticeGeometryPartSchema),
    needsReview: z.boolean(),
    reviewReasons: z.array(z.string()),
  })
  .refine(
    (n) => !n.activeTo || n.activeFrom.getTime() <= n.activeTo.getTime(),
    {
      message: 'activeFrom must be on or before activeTo',
      path: ['activeFrom'],
    },
  );

// Run the structural schema over each record and fold any failure into the
// record's needsReview / reviewReasons instead of throwing. Returns a new array;
// never throws and never drops a record.
//
// Persisting a flagged record is storable for every realistic failure: `areas`
// is jsonb (out-of-range coordinates serialize fine) and `title` is a plain text
// column (an empty string inserts fine). The one genuinely un-storable case — an
// Invalid Date in a NOT NULL timestamptz column — cannot arise here because the
// adapter coerces every date via `parseDate(...) ?? new Date()`.
export function flagInvalidNotices(notices: ParsedNotice[]): ParsedNotice[] {
  return notices.map((notice) => {
    const result = ParsedNoticeSchema.safeParse(notice);
    if (result.success) return notice;
    const reasons = result.error.issues.map(
      (iss) => `invalid_field:${iss.path.join('.') || '(root)'}:${iss.message}`,
    );
    return {
      ...notice,
      needsReview: true,
      reviewReasons: [...notice.reviewReasons, ...reasons],
    };
  });
}
