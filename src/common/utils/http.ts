import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

// Shared across all scrapers — tough-cookie scopes cookies by domain, so this
// is safe. Some endpoints (e.g. Malta Met Office's mariner forecast) require
// a CSRF cookie primed on a prior request, which only works if cookies persist.
export const cookieJar = new CookieJar();

export const impit = new Impit({
  browser: 'chrome',
  ignoreTlsErrors: true,
  cookieJar,
});

export async function fetchText(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<string> {
  const res = await impit.fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// Historical alias — most callers fetch HTML, but the underlying read is just
// text. Kept so existing scrapers don't churn.
export const fetchHtml = fetchText;

export async function fetchBuffer(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<Buffer> {
  const res = await impit.fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
