import { ADAPTERS } from './adapters';

describe('feature adapters', () => {
  describe('diving-sites', () => {
    const adapt = ADAPTERS['diving-sites'];

    it('prefers siteName over location, falls back to text', () => {
      expect(
        adapt({ siteName: 'P29', location: null, text: 'Other' })?.title,
      ).toBe('P29');
      expect(
        adapt({ siteName: null, location: 'Cirkewwa', text: 'X' })?.title,
      ).toBe('Cirkewwa');
      expect(
        adapt({ siteName: null, location: null, text: 'Fallback' })?.title,
      ).toBe('Fallback');
    });

    it('drops the feature when no name is available', () => {
      expect(adapt({ siteName: '', location: null, text: '   ' })).toBeNull();
    });

    it('omits description when hasDescription is not true', () => {
      const result = adapt({
        siteName: 'X',
        shortDescription: 'irrelevant boilerplate',
        hasDescription: 'false',
      });
      expect(result?.description).toBeUndefined();
    });

    it('splits multi-interest tags and skips "N/A"', () => {
      expect(
        adapt({ siteName: 'X', interest: 'Cave & Reef & Wall' })?.tags,
      ).toEqual(['Cave', 'Reef', 'Wall']);
      expect(adapt({ siteName: 'X', interest: 'N/A' })?.tags).toBeUndefined();
    });

    it('formats depth as a range when avg and max differ', () => {
      const result = adapt({
        siteName: 'X',
        depthAverageMeters: '5',
        depthAverageIsMinimum: 'true',
        depthMaxMeters: '30',
        depthMaxIsMinimum: 'true',
      });
      expect(result?.details).toContainEqual({
        label: 'Depth',
        value: '5–30+ m',
      });
    });

    it('parses youtube to a bare video ID, stripping start/end timestamps', () => {
      expect(
        adapt({ siteName: 'X', youtube: 'DNvMSdjlCIE,0,0' })?.media?.youtubeIds,
      ).toEqual(['DNvMSdjlCIE']);
      expect(adapt({ siteName: 'X', youtube: '' })?.media).toBeUndefined();
    });

    it('parses links with optional |Label suffix', () => {
      const result = adapt({
        siteName: 'X',
        links:
          'http://www.wrecksite.eu/wreck.aspx?58012|Wrecksite.eu http://en.wikipedia.org/wiki/MV_Rozi|Wikipedia.org https://sketchfab.com/models/47a7541a59c8425e',
      });
      expect(result?.links).toEqual([
        {
          url: 'http://www.wrecksite.eu/wreck.aspx?58012',
          label: 'Wrecksite.eu',
        },
        { url: 'http://en.wikipedia.org/wiki/MV_Rozi', label: 'Wikipedia.org' },
        { url: 'https://sketchfab.com/models/47a7541a59c8425e' },
      ]);
    });

    it('drops non-http garbage from the links field', () => {
      const result = adapt({
        siteName: 'X',
        links: 'ftp://nope chunky-text http://ok.com',
      });
      expect(result?.links).toEqual([{ url: 'http://ok.com' }]);
    });

    it('returns rating only when both value and count are positive', () => {
      expect(
        adapt({ siteName: 'X', rating: '4.2', ratings: '5' })?.rating,
      ).toEqual({
        value: 4.2,
        count: 5,
      });
      expect(
        adapt({ siteName: 'X', rating: '0', ratings: '0' })?.rating,
      ).toBeUndefined();
    });

    it('exposes the upstream maltadives URL as sourceUrl', () => {
      expect(
        adapt({
          siteName: 'X',
          identifier: 'https://maltadives.com/sites/cirkewwa',
        })?.sourceUrl,
      ).toBe('https://maltadives.com/sites/cirkewwa');
      expect(
        adapt({ siteName: 'X', identifier: 'not-a-url' })?.sourceUrl,
      ).toBeUndefined();
    });
  });

  describe('anchoring-and-mooring-hotspots', () => {
    const adapt = ADAPTERS['anchoring-and-mooring-hotspots'];

    it('uses text as title and exposes CharacterString as the authority detail', () => {
      const result = adapt({
        text: 'Mgarr ix-Xini',
        description: 'Boating hotspot - Seasonal',
        CharacterString: 'Authority for Transport in Malta',
        beginLifespanVersion: '2020-04-23T22:00:00Z',
        identifier: 'https://data.gov.mt/anchoring/1',
      });
      expect(result?.title).toBe('Mgarr ix-Xini');
      expect(result?.subtitle).toBe('Boating hotspot');
      expect(result?.description).toBe('Boating hotspot - Seasonal');
      expect(result?.tags).toEqual(['Seasonal']);
      expect(result?.details).toEqual([
        { label: 'Authority', value: 'Authority for Transport in Malta' },
        { label: 'Published', value: '2020-04-23' },
      ]);
      expect(result?.sourceUrl).toBe('https://data.gov.mt/anchoring/1');
    });
  });

  describe('bunkering-areas', () => {
    const adapt = ADAPTERS['bunkering-areas'];

    it('prefers the upstream display area number over localId', () => {
      expect(adapt({ localId: 'bunkeringArea_2', name: 'Area 4' })?.title).toBe(
        'Bunkering area 4',
      );
      expect(
        adapt({ localId: 'bunkeringArea_3', description: 'x' })?.title,
      ).toBe('Bunkering area 3');
      expect(adapt({ localId: null })?.title).toBe('Bunkering area');
    });
  });

  describe('beaches', () => {
    const adapt = ADAPTERS['beaches'];

    const base = {
      Site_Code: 'A01',
      Description: 'A rocky beach along the southern coast.',
      Name_MT: 'Il-Kalanka tal-Irgiel',
      Name_ENG: 'Kalanka tal-Irgiel',
      Local_Council: 'Xghajra',
      Blue_Flag_OR_Beach_of_Quality: 'No',
      Bathing_Water_Profile: 'https://environmentalhealth.gov.mt/bwp-1/',
      Sandy_OR_Rocky_Beach: 'Rocky beach',
      Pet_Friendly: 'No',
      RecommendedForBathing_YES_OR_NO: 'Yes',
      Pubic_convenience: 'N/A',
    };

    it('prefers the English name, falling back to Maltese then site code', () => {
      expect(adapt(base)?.title).toBe('Kalanka tal-Irgiel');
      expect(adapt({ ...base, Name_ENG: null })?.title).toBe(
        'Il-Kalanka tal-Irgiel',
      );
      expect(
        adapt({ Site_Code: 'B02', Name_ENG: null, Name_MT: null })?.title,
      ).toBe('Bathing site B02');
      expect(adapt({})).toBeNull();
    });

    it('exposes the bathing-water profile as a link and the source URL', () => {
      const result = adapt(base);
      expect(result?.links).toEqual([
        {
          url: 'https://environmentalhealth.gov.mt/bwp-1/',
          label: 'Bathing water profile',
        },
      ]);
      expect(result?.sourceUrl).toBe(
        'https://environmentalhealth.gov.mt/bwp-1/',
      );
      expect(result?.sourceId).toBe('A01');
    });

    it('tags positive attributes and normalises beach-type casing', () => {
      const result = adapt({
        ...base,
        Sandy_OR_Rocky_Beach: 'Sandy Beach',
        Blue_Flag_OR_Beach_of_Quality: 'Yes',
        Pet_Friendly: 'Yes',
        RecommendedForBathing_YES_OR_NO: 'No',
      });
      expect(result?.tags).toEqual([
        'Sandy beach',
        'Blue Flag / Beach of Quality',
        'Pet friendly',
        'Not recommended for bathing',
      ]);
    });

    it('drops the Maltese-name detail when it matches the title and the NA placeholders', () => {
      const result = adapt({
        ...base,
        Name_MT: 'Kalanka tal-Irgiel',
        Sandy_OR_Rocky_Beach: 'NA',
      });
      const labels = (result?.details ?? []).map((d) => d.label);
      expect(labels).not.toContain('Maltese name');
      expect(labels).not.toContain('Beach type');
      expect(labels).not.toContain('Public convenience');
    });
  });
});
