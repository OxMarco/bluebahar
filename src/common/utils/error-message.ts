// Narrow an unknown caught value to a human-readable message: Error.message
// when it's an Error, otherwise its String() form.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
