import { NoticeKind } from '../notice-kind';
import { matchLayer, matchesPlacemark } from './layers.config';

describe('community-map layers config', () => {
  describe('matchLayer', () => {
    it.each([
      ['Swimmer Zones & Restricted Navigational Areas 2026', 'swimmer-zones'],
      ['Swimmer Zones & Restricted Navigational Areas 2027', 'swimmer-zones'],
      [
        'Conservation Areas around Wrecks – Notice to Mariners 113 of 2024',
        'wreck-conservation',
      ],
      [
        'Archaeological Zones at Sea – Superintendence of Cultural Heritage – Notice to Mariners 02 of 2024',
        'archaeological-zones',
      ],
      [
        'LIFE Garnija Project – Notice to Mariners 09 & 10 of 2023',
        'life-garnija',
      ],
      ['Other Areas with Restrictions', 'other-restrictions'],
    ])('matches marine layer %s', (folder, key) => {
      expect(matchLayer(folder)?.key).toBe(key);
      expect(matchLayer(folder)?.kind).toBe(NoticeKind.ALERT);
    });

    it.each([
      'Tree Protection Areas (TPA)',
      'Designated Camping Areas',
      'Natura 2000 Sites',
      'Bird Sanctuaries & Beaches – No hunting or trapping allowed',
      'Designated Dog Friendly Beaches',
    ])('returns null for terrestrial layer %s', (folder) => {
      expect(matchLayer(folder)).toBeNull();
    });
  });

  describe('matchesPlacemark', () => {
    it('allows only marine entries from the mixed Other Areas layer', () => {
      const other = matchLayer('Other Areas with Restrictions')!;
      expect(matchesPlacemark(other, "Bay Pillar – St.Paul's Bay")).toBe(true);
      expect(
        matchesPlacemark(other, 'Marsascala Local Council – Restrictions'),
      ).toBe(false);
      expect(
        matchesPlacemark(other, 'il-Majjistral Nature and History Park'),
      ).toBe(false);
    });

    it('allows every placemark in dedicated marine layers', () => {
      const swimmers = matchLayer('Swimmer Zones 2026')!;
      expect(matchesPlacemark(swimmers, 'Blue Lagoon')).toBe(true);
    });
  });
});
