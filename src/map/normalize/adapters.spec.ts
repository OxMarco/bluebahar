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

  describe('marine-caves', () => {
    const adapt = ADAPTERS['marine-caves'];

    it('capitalizes geomorphic type as a single tag', () => {
      const result = adapt({
        name: 'Bottleneck Cave',
        description: 'on Gozo',
        naturalGeomorphologicFeatureType: 'erosional',
        localId: '10',
        identifier: 'https://data.gov.mt/cave/10',
        mappingFrame: 'topOfBedrock',
      });
      expect(result?.tags).toEqual(['Gozo', 'Erosional']);
      expect(result?.title).toBe('Bottleneck Cave');
      expect(result?.description).toBe('on Gozo');
      expect(result?.details).toEqual([
        { label: 'Mapping frame', value: 'Top of bedrock' },
      ]);
      expect(result?.sourceId).toBe('10');
      expect(result?.sourceUrl).toBe('https://data.gov.mt/cave/10');
    });

    it('uses the cave local id when upstream has no display name', () => {
      const result = adapt({
        name: '(Name not available)',
        localId: '12',
        naturalGeomorphologicFeatureType: 'erosional',
      });
      expect(result?.title).toBe('Marine cave 12');
    });

    it('drops the feature when name is missing', () => {
      expect(adapt({ name: null, description: 'x' })).toBeNull();
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
});
