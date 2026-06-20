const HTTP_TIMEOUT_MS = 30_000;

function withTimeout(signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function fetchResponse(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: withTimeout(init.signal) });
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
): Promise<string> {
  const response = await fetchResponse(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}
