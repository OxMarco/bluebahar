import {
  classificationLabel,
  classificationRank,
  classificationTags,
  normalizeSiteCode,
  parseClassification,
  SITE_CODE_PATTERN,
} from './classification';

describe('bathing-water classification', () => {
  describe('parseClassification', () => {
    it('maps printed report words to the machine value', () => {
      expect(parseClassification('Excellent')).toBe('excellent');
      expect(parseClassification('CLOSED')).toBe('closed');
      expect(parseClassification('  Inaccessible ')).toBe('inaccessible');
    });

    it('returns null for anything unrecognised', () => {
      expect(parseClassification('unknown')).toBeNull();
      expect(parseClassification('')).toBeNull();
      expect(parseClassification(42)).toBeNull();
    });
  });

  describe('normalizeSiteCode', () => {
    it('strips spaces and upper-cases', () => {
      expect(normalizeSiteCode('a01')).toBe('A01');
      expect(normalizeSiteCode('B 10')).toBe('B10');
      expect(normalizeSiteCode(' d 23 ')).toBe('D23');
    });

    it('produces codes matching the A01–D23 pattern', () => {
      expect(SITE_CODE_PATTERN.test(normalizeSiteCode('C 32'))).toBe(true);
      expect(SITE_CODE_PATTERN.test('Zone A')).toBe(false);
    });
  });

  describe('rank and label', () => {
    it('ranks the EU quality grades 4→1 and statuses 0', () => {
      expect(classificationRank('excellent')).toBe(4);
      expect(classificationRank('poor')).toBe(1);
      expect(classificationRank('closed')).toBe(0);
      expect(classificationRank('inaccessible')).toBe(0);
    });

    it('renders a display label', () => {
      expect(classificationLabel('sufficient')).toBe('Sufficient');
      expect(classificationLabel('closed')).toBe('Closed');
    });
  });

  describe('classificationTags', () => {
    it('flags closed sites prominently', () => {
      expect(
        classificationTags({ classification: 'closed', healthWarning: false }),
      ).toEqual(['CLOSED — bathing not recommended']);
    });

    it('flags a poor rating and a health warning together', () => {
      expect(
        classificationTags({ classification: 'poor', healthWarning: true }),
      ).toEqual(['Poor water quality', 'Health warning']);
    });

    it('adds no tag for the good quality grades', () => {
      expect(
        classificationTags({
          classification: 'excellent',
          healthWarning: false,
        }),
      ).toEqual([]);
      expect(
        classificationTags({ classification: 'good', healthWarning: false }),
      ).toEqual([]);
    });

    it('surfaces a health warning even on an otherwise-good grade', () => {
      expect(
        classificationTags({ classification: 'good', healthWarning: true }),
      ).toEqual(['Health warning']);
    });
  });
});
