import { flagInvalidNotices } from './validate';
import type { ParsedNotice } from './adapter';
import { NoticeKind } from '../../notice-kind';

function notice(over: Partial<ParsedNotice> = {}): ParsedNotice {
  return {
    kind: NoticeKind.INFO,
    title: 'Minimum Towage Requirement',
    description: 'Tug requirements for listed terminals.',
    source:
      'https://www.transport.gov.mt/include/filestreaming.asp?fileid=11606',
    subKey: '',
    publishedAt: new Date('2026-06-01T00:00:00.000Z'),
    activeFrom: new Date('2026-06-01T00:00:00.000Z'),
    areas: [],
    needsReview: false,
    reviewReasons: [],
    ...over,
  };
}

describe('flagInvalidNotices', () => {
  it('passes a well-formed notice through unchanged', () => {
    const input = notice();
    const [out] = flagInvalidNotices([input]);
    expect(out).toBe(input);
    expect(out.needsReview).toBe(false);
    expect(out.reviewReasons).toEqual([]);
  });

  it('never throws and never drops a record', () => {
    const out = flagInvalidNotices([notice({ title: '' }), notice()]);
    expect(out).toHaveLength(2);
  });

  it('flags an empty title for review instead of rejecting it', () => {
    const [out] = flagInvalidNotices([notice({ title: '' })]);
    expect(out.needsReview).toBe(true);
    expect(out.reviewReasons.some((r) => r.includes('title'))).toBe(true);
  });

  it('flags a whitespace-only title', () => {
    const [out] = flagInvalidNotices([notice({ title: '   ' })]);
    expect(out.needsReview).toBe(true);
    expect(out.reviewReasons.some((r) => r.includes('title'))).toBe(true);
  });

  it('does NOT touch a URL-like title (a soft needsReview concern handled by the adapter)', () => {
    const input = notice({
      title: 'filestreaming.asp?fileid=11606',
      needsReview: true,
      reviewReasons: ['title_looks_like_url'],
    });
    const [out] = flagInvalidNotices([input]);
    // Title is a valid non-empty string structurally, so the validator adds no
    // new reason — the adapter already flagged it.
    expect(out.reviewReasons).toEqual(['title_looks_like_url']);
  });

  it('flags an out-of-range coordinate', () => {
    const [out] = flagInvalidNotices([
      notice({
        areas: [
          {
            label: 'Zone',
            geometryType: 'point',
            points: [{ lat: 91, long: 14 }],
          },
        ],
      }),
    ]);
    expect(out.needsReview).toBe(true);
    expect(out.reviewReasons.some((r) => r.includes('lat'))).toBe(true);
  });

  it('flags an inverted validity window (activeFrom after activeTo)', () => {
    const [out] = flagInvalidNotices([
      notice({
        activeFrom: new Date('2026-06-10T00:00:00.000Z'),
        activeTo: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ]);
    expect(out.needsReview).toBe(true);
    expect(out.reviewReasons.some((r) => r.includes('activeFrom'))).toBe(true);
  });

  it('preserves existing review reasons when adding structural ones', () => {
    const [out] = flagInvalidNotices([
      notice({
        title: '',
        needsReview: true,
        reviewReasons: ['point_outside_malta_bbox:1A'],
      }),
    ]);
    expect(out.reviewReasons).toContain('point_outside_malta_bbox:1A');
    expect(out.reviewReasons.length).toBeGreaterThan(1);
  });
});
