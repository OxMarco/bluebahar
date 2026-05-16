import { entryToArea, lookupPlace } from './gazetteer';

describe('notice gazetteer', () => {
  it('resolves exact and diacritic-insensitive place names', () => {
    const plain = lookupPlace('Mgarr Harbour');
    const accented = lookupPlace('Mġarr Harbour');

    expect(plain).toEqual(accented);
    expect(plain?.kind).toBe('point');
    if (!plain || plain.kind !== 'point') {
      throw new Error('Expected Mġarr Harbour to resolve to a point');
    }
    expect(typeof plain.lat).toBe('number');
    expect(typeof plain.long).toBe('number');
  });

  it('resolves contained harbour names from longer labels', () => {
    const entry = lookupPlace('Temporary works at Berth 12, Grand Harbour');

    expect(entry?.kind).toBe('polygon');
    if (!entry || entry.kind !== 'polygon') {
      throw new Error('Expected Grand Harbour to resolve to a polygon');
    }

    const area = entryToArea(entry);
    expect(area.length).toBeGreaterThan(0);
    expect(typeof area[0]?.lat).toBe('number');
    expect(typeof area[0]?.long).toBe('number');
  });

  it('returns null for unknown locations', () => {
    expect(lookupPlace('Definitely Not A Maltese Harbour')).toBeNull();
  });
});
