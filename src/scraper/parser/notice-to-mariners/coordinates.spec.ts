import type { PdfLine } from './pdf-text';
import { extractCoordinates, validateAreaCoordinates } from './coordinates';

function line(text: string, xStart = 10, y = 100): PdfLine {
  return {
    page: 1,
    lineIdx: 0,
    text,
    y,
    xStart,
    xEnd: xStart + 300,
  };
}

describe('notice coordinate parsing', () => {
  it('extracts DMS latitude/longitude pairs with point labels', () => {
    const [coord] = extractCoordinates([
      line("A 35\u00b0 54'.731 N 014\u00b0 29'.564 E"),
    ]);

    expect(coord.pointLabel).toBe('A');
    expect(coord.lat).toBeCloseTo(35 + 54.731 / 60, 6);
    expect(coord.long).toBeCloseTo(14 + 29.564 / 60, 6);
    expect(coord.page).toBe(1);
  });

  it('pairs coordinates split across same-row PDF line segments', () => {
    const [coord] = extractCoordinates([
      line("B 35\u00b0 54'.290 N", 10, 100),
      line("014\u00b0 30'.100 E", 180, 102),
    ]);

    expect(coord.pointLabel).toBe('B');
    expect(coord.lat).toBeCloseTo(35 + 54.29 / 60, 6);
    expect(coord.long).toBeCloseTo(14 + 30.1 / 60, 6);
  });

  it('extracts compact coordinates when a PDF drops the degree symbol', () => {
    const [coord] = extractCoordinates([line("C 3554'.290 01430'.100")]);

    expect(coord.pointLabel).toBe('C');
    expect(coord.lat).toBeCloseTo(35 + 54.29 / 60, 6);
    expect(coord.long).toBeCloseTo(14 + 30.1 / 60, 6);
  });

  it('flags coordinates outside the Malta maritime area or well inland', () => {
    expect(validateAreaCoordinates([{ lat: 34, long: 14 }])).toEqual([
      expect.stringContaining('outside the Malta maritime region'),
    ]);
    expect(validateAreaCoordinates([{ lat: 35.89, long: 14.45 }])).toEqual([
      expect.stringContaining('falls on Maltese land'),
    ]);
  });
});
