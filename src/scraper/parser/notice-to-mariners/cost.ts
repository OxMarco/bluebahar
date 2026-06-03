// Rough USD cost estimate from token usage. Vendored from the mariner-parser
// project (bench/strategies/_shared.ts). Rates are best-effort approximations.
export function estimateCost(
  model: string,
  inTok: number,
  outTok: number,
): number {
  const rates: Record<string, [number, number]> = {
    // [in $/Mtok, out $/Mtok] — approximate
    'gpt-5.5': [1.25, 10],
    'gpt-5.5-pro': [15, 120],
    'gpt-5.1': [1.25, 10],
    'gpt-5': [1.25, 10],
    'gpt-5-mini': [0.25, 2],
    'gpt-5-nano': [0.05, 0.4],
    'gpt-4.1': [2, 8],
    'gpt-4o': [2.5, 10],
    'gpt-4o-mini': [0.15, 0.6],
  };
  const key = Object.keys(rates).find((k) => model.startsWith(k)) ?? 'gpt-5.5';
  const [ri, ro] = rates[key];
  return (inTok / 1e6) * ri + (outTok / 1e6) * ro;
}
