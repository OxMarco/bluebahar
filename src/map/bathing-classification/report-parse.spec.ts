import { MIN_EXPECTED_SITE_COUNT, validateParsedReport } from './report-parse';

// Build a syntactically valid set of N sites (A01, A02, …) classified excellent,
// so tests can focus on one varying concern at a time.
function manySites(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    siteCode: `A${String(i + 1).padStart(2, '0')}`,
    classification: 'excellent' as const,
    healthWarning: false,
  }));
}

describe('validateParsedReport', () => {
  it('canonicalises codes, maps classes, and keeps the publish date', () => {
    const result = validateParsedReport({
      publishedOn: '1 June 2026',
      sites: [
        { siteCode: 'B 10', classification: 'closed', healthWarning: true },
        ...manySites(MIN_EXPECTED_SITE_COUNT),
      ],
    });

    expect(result.publishedOn).toBe('1 June 2026');
    expect(result.classifications.get('B10')).toEqual({
      classification: 'closed',
      healthWarning: true,
      publishedOn: '1 June 2026',
    });
    expect(result.classifications.size).toBe(MIN_EXPECTED_SITE_COUNT + 1);
  });

  it('drops rows whose site code is not a real A01–D23 code', () => {
    const result = validateParsedReport({
      publishedOn: '',
      sites: [
        { siteCode: 'Zone A', classification: 'good', healthWarning: false },
        ...manySites(MIN_EXPECTED_SITE_COUNT),
      ],
    });

    expect(result.classifications.has('ZONEA')).toBe(false);
    expect(result.classifications.size).toBe(MIN_EXPECTED_SITE_COUNT);
  });

  it('de-dupes a repeated site code, keeping the first occurrence', () => {
    const result = validateParsedReport({
      publishedOn: '',
      sites: [
        { siteCode: 'A01', classification: 'poor', healthWarning: false },
        { siteCode: 'A01', classification: 'good', healthWarning: false },
        ...manySites(MIN_EXPECTED_SITE_COUNT).slice(1),
      ],
    });

    expect(result.classifications.get('A01')?.classification).toBe('poor');
  });

  it('leaves the publish date undefined when blank', () => {
    const result = validateParsedReport({
      publishedOn: '   ',
      sites: manySites(MIN_EXPECTED_SITE_COUNT),
    });
    expect(result.publishedOn).toBeUndefined();
  });

  it('rejects a report with too few sites (truncated/misread PDF)', () => {
    expect(() =>
      validateParsedReport({
        publishedOn: '',
        sites: manySites(MIN_EXPECTED_SITE_COUNT - 1),
      }),
    ).toThrow(/minimum trusted count/);
  });

  it('rejects a parse far enough below the 87-site report to imply an omitted zone', () => {
    expect(() =>
      validateParsedReport({
        publishedOn: '15 June 2026',
        sites: manySites(79),
      }),
    ).toThrow(/minimum trusted count is 80/);
  });

  it('rejects output that does not match the schema', () => {
    expect(() => validateParsedReport({ sites: 'nope' })).toThrow();
  });
});
