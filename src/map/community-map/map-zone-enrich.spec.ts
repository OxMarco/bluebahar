import type OpenAI from 'openai';
import { enrichMapZone } from './map-zone-enrich';

// Stand-in for the map's copyrighted placemark prose. The whole point of
// enrichMapZone is that this text is NEVER fed to the model (or stored), so the
// description we generate can't be derivative of it. The function signature
// can't even accept it — this test pins that guarantee against the actual
// payload sent to the model.
const COPYRIGHTED_MAP_PROSE =
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
  it('sends only owned facts (class + brief + place), never map prose', async () => {
    const { client, calls } = mockClient({
      summary: 'A protected wreck site near Żurrieq; keep clear unless diving.',
      recommended_action:
        'Do not enter or moor unless engaged in permitted diving.',
    });

    await enrichMapZone(client, {
      category: 'wreck conservation',
      zoneName: 'Um el Faroud',
      restrictionBrief:
        'Conservation area around a protected historic wreck. Entry limited to permitted diving vessels.',
    });

    const payload = calls[0];
    const serialised = JSON.stringify(payload);

    expect(serialised).not.toContain(COPYRIGHTED_MAP_PROSE);
    const userMsg = payload.input.find((m) => m.role === 'user')!.content;
    expect(userMsg).toContain('Um el Faroud');
    expect(userMsg).toContain('protected historic wreck');
    // Nothing else is fed in — the user message is exactly our three fact lines.
    expect(userMsg.split('\n')).toHaveLength(3);
  });

  it('returns the validated structured fields', async () => {
    const { client } = mockClient({
      summary: 'Swimmers zone in the Blue Lagoon; vessels keep out.',
      recommended_action: 'Navigate clear of the marked limits.',
    });
    const out = await enrichMapZone(client, {
      category: 'swimmer zones',
      zoneName: 'Blue Lagoon – Comino',
      restrictionBrief: 'Area reserved for bathers and closed to navigation.',
    });
    expect(out.summary).toMatch(/Blue Lagoon/);
    expect(out.recommended_action).toMatch(/clear/);
  });
});
