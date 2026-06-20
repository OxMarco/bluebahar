import {
  parseDistance,
  parseNoticeDate,
  parseNoticeRef,
  parseSourceUrl,
  parseValidity,
} from './validity';

describe('parseValidity', () => {
  it('parses a seasonal start date from the real swimmer-zone prose', () => {
    const desc =
      'Notice to Mariners 059 of 2026 – Zones reserved for swimmers in Blue Lagoon, Comino. ' +
      'No vessels or objects which may endanger the safety of bathers shall be used within a swimmers’ zone. ' +
      'These restrictions are in place from the 9th of April 2026. For more information: https://example.com';
    const v = parseValidity(desc);
    expect(v.from?.toISOString()).toBe('2026-04-09T00:00:00.000Z');
    expect(v.to).toBeUndefined();
  });

  it('parses an explicit end date (end-of-day) when stated', () => {
    const v = parseValidity(
      'Restrictions are effective from 1 June 2026 until 30 September 2026.',
    );
    expect(v.from?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(v.to?.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });

  it('strips HTML before matching', () => {
    const v = parseValidity(
      'In place <b>from the 15th of May 2025</b>.<br/>See <a href="x">link</a>.',
    );
    expect(v.from?.toISOString()).toBe('2025-05-15T00:00:00.000Z');
  });

  it('returns nothing for standing designations', () => {
    expect(parseValidity('Applies all year round and at all times.')).toEqual(
      {},
    );
    expect(parseValidity('')).toEqual({});
    expect(parseValidity(null)).toEqual({});
  });

  it('ignores an unparseable month', () => {
    expect(parseValidity('in place from the 9th of Smarch 2026')).toEqual({});
  });
});

describe('parseNoticeDate', () => {
  it('reads the year from the folder label of a standing designation', () => {
    expect(
      parseNoticeDate(
        'LIFE Garnija Project – Notice to Mariners 09 & 10 of 2023',
      )?.toISOString(),
    ).toBe('2023-01-01T00:00:00.000Z');
  });

  it('crosses the "No." abbreviation in a local notice reference', () => {
    expect(
      parseNoticeDate(
        'This area is not to be used by swimmers since it has been declared ' +
          'dangerous, as per Local Notice to Mariners No. 132 of 2025.',
      )?.toISOString(),
    ).toBe('2025-01-01T00:00:00.000Z');
  });

  it('reads the year through HTML in a placemark description', () => {
    expect(
      parseNoticeDate(
        '<b>Notice to Mariners 059 of 2026</b><br>Zones reserved for swimmers.',
      )?.toISOString(),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null when there is no notice reference', () => {
    expect(parseNoticeDate('Other Areas with Restrictions')).toBeNull();
    expect(parseNoticeDate('Applies all year round.')).toBeNull();
    expect(parseNoticeDate('')).toBeNull();
    expect(parseNoticeDate(null)).toBeNull();
  });

  it('rejects an implausible year', () => {
    expect(parseNoticeDate('Notice to Mariners 1 of 1899')).toBeNull();
  });
});

describe('parseNoticeRef', () => {
  it('captures the full reference from a folder label', () => {
    expect(
      parseNoticeRef(
        'LIFE Garnija Project – Notice to Mariners 09 & 10 of 2023',
      ),
    ).toBe('Notice to Mariners 09 & 10 of 2023');
  });

  it('captures the plural wording used by restricted navigational areas', () => {
    expect(
      parseNoticeRef(
        'Notices to Mariners 077 of 2026 – Restricted Navigational Areas.',
      ),
    ).toBe('Notices to Mariners 077 of 2026');
  });

  it('captures a "Local Notice … No." reference through HTML', () => {
    expect(
      parseNoticeRef(
        'Declared dangerous, as per <b>Local Notice to Mariners No. 132 of 2025</b>.',
      ),
    ).toBe('Local Notice to Mariners No. 132 of 2025');
  });

  it('returns null without a reference', () => {
    expect(parseNoticeRef('Other Areas with Restrictions')).toBeNull();
    expect(parseNoticeRef(null)).toBeNull();
  });
});

describe('parseSourceUrl', () => {
  it('extracts the first link and trims trailing punctuation', () => {
    expect(
      parseSourceUrl(
        'All year round.<br><br>https://www.transport.gov.mt/include/filestreaming.asp?fileid=8435',
      ),
    ).toBe(
      'https://www.transport.gov.mt/include/filestreaming.asp?fileid=8435',
    );
    expect(
      parseSourceUrl('See https://legislation.mt/eli/sl/549.83/eng/pdf.'),
    ).toBe('https://legislation.mt/eli/sl/549.83/eng/pdf');
  });

  it('returns null when there is no link', () => {
    expect(parseSourceUrl('All year round and at all times.')).toBeNull();
    expect(parseSourceUrl(null)).toBeNull();
  });
});

describe('parseDistance', () => {
  it('reads a minimum-distance figure in metres', () => {
    expect(
      parseDistance(
        'All transiting traffic to maintain a minimum distance of 100m.',
      ),
    ).toBe(100);
    expect(parseDistance('keep a distance of 50 metres')).toBe(50);
  });

  it('converts a nautical-mile restriction radius to metres', () => {
    expect(parseDistance('No stopping and no anchoring zone of 0.5 NM.')).toBe(
      926,
    );
  });

  it('does not mistake a speed or other number for a distance', () => {
    expect(
      parseDistance('Maximum speed 3 Knots. Only compulsory lights.'),
    ).toBeNull();
    expect(parseDistance('')).toBeNull();
    expect(parseDistance(null)).toBeNull();
  });
});
