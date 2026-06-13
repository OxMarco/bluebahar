const SWEAR_WORDS = [
  'arsehole',
  'asshole',
  'bastard',
  'bitch',
  'bollocks',
  'bullshit',
  'crap',
  'cunt',
  'damn',
  'dick',
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'motherfucker',
  'piss',
  'pissed',
  'prick',
  'shit',
  'shitty',
  'slut',
  'twat',
  'wanker',
] as const;

const SWEAR_WORD_PATTERN = new RegExp(
  `(^|[^a-z0-9])(${SWEAR_WORDS.map(escapeRegExp).join('|')})(?=$|[^a-z0-9])`,
  'i',
);

export function containsSwearWord(...values: string[]): boolean {
  return values.some((value) =>
    SWEAR_WORD_PATTERN.test(value.normalize('NFKC')),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
