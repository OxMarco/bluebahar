import type OpenAI from 'openai';
import { enrichMapZone } from './map-zone-enrich';

// Stand-in for a placemark description. The model must see it to extract the
// zone-specific rules, while the application stores only the rewritten output.
const MAP_SOURCE_TEXT =
  'Within these Conservation Areas, only vessels engaged in recreational/technical diving operations are permitted to enter or moor within…';

type CreateArg = { input: { role: string; content: string }[] };

function mockClient(output: object) {
  const calls: CreateArg[] = [];
  const create = (arg: CreateArg): Promise<{ output_text: string }> => {
    calls.push(arg);
    return Promise.resolve({ output_text: JSON.stringify(output) });
  };
  return {
    client: { responses: { create } } as unknown as OpenAI,
    calls,
  };
}

describe('enrichMapZone', () => {
  it('sends the placemark text as untrusted extraction source material', async () => {
    const { client, calls } = mockClient({
      title: 'Um el Faroud wreck',
      summary: 'A protected wreck site near Żurrieq; keep clear unless diving.',
      restrictions: [
        'Only recreational or technical diving vessels may enter or moor.',
      ],
    });

    await enrichMapZone(client, {
      category: 'wreck conservation',
      zoneName: 'Um el Faroud',
      restrictionBrief:
        'Conservation area around a protected historic wreck. Entry limited to permitted diving vessels.',
      sourceText: MAP_SOURCE_TEXT,
    });

    const payload = calls[0];
    const userMsg = payload.input.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('Um el Faroud');
    expect(userMsg).toContain('protected historic wreck');
    expect(userMsg).toContain(MAP_SOURCE_TEXT);
    expect(userMsg).toContain('<source>');
  });

  it('passes deterministic facts alongside the source material', async () => {
    const { client, calls } = mockClient({
      title: 'Majjistral seabird zone',
      summary: 'A seabird protection area off Majjistral; keep 100 m clear.',
      restrictions: [
        'Vessels must remain at least 100 m clear.',
        'Only compulsory lights and sounds may be used.',
      ],
    });

    await enrichMapZone(client, {
      category: 'life garnija',
      zoneName: 'Majjistral NHP',
      restrictionBrief: 'Seabird protection area at sea.',
      sourceText:
        'All transiting traffic must maintain 100m clearance. Only compulsory lights and sounds.',
      facts: [
        'Vessels must keep at least 100 m clear.',
        'Established by Notice to Mariners 09 & 10 of 2023.',
      ],
    });

    const payload = calls[0];
    const userMsg = payload.input.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('keep at least 100 m clear');
    expect(userMsg).toContain('Notice to Mariners 09 & 10 of 2023');
    expect(userMsg).toContain('Only compulsory lights and sounds');
  });

  it('returns the validated structured fields', async () => {
    const { client } = mockClient({
      title: 'Blue Lagoon swim zone',
      summary: 'Swimmers zone in the Blue Lagoon; vessels keep out.',
      restrictions: [
        'Vessels and fishing gear are prohibited inside the zone.',
      ],
    });
    const out = await enrichMapZone(client, {
      category: 'swimmer zones',
      zoneName: 'Blue Lagoon – Comino',
      restrictionBrief: 'Area reserved for bathers and closed to navigation.',
      sourceText:
        'No vessels or fishing gear may be used within the swimmers zone.',
    });
    expect(out.title).toBe('Blue Lagoon swim zone');
    expect(out.summary).toMatch(/Blue Lagoon/);
    expect(out.restrictions).toHaveLength(1);
  });

  it('rejects output that contains no operational restrictions', async () => {
    const { client } = mockClient({
      title: 'Generic zone',
      summary: 'A generic zone description.',
      restrictions: ['  '],
    });

    await expect(
      enrichMapZone(client, {
        category: 'other restrictions',
        zoneName: 'Test zone',
        restrictionBrief: 'A restricted marine area.',
        sourceText: 'Maximum speed is 5 knots.',
      }),
    ).rejects.toThrow('omitted operational restrictions');
  });

  it('rejects output with a blank title', async () => {
    const { client } = mockClient({
      title: '   ',
      summary: 'Swimmers zone; vessels keep out.',
      restrictions: ['Vessels are prohibited inside the zone.'],
    });

    await expect(
      enrichMapZone(client, {
        category: 'swimmer zones',
        zoneName: 'Test zone',
        restrictionBrief: 'A restricted marine area.',
        sourceText: 'No vessels may enter the swimmers zone.',
      }),
    ).rejects.toThrow('omitted the title');
  });
});
