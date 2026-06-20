import { parseValidity } from './validity';

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
