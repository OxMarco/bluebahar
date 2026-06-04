import { Impit } from 'impit';
import { CookieJar } from 'tough-cookie';

// Shared across all scrapers — tough-cookie scopes cookies by domain, so this
// is safe. Some endpoints (e.g. Malta Met Office's mariner forecast) require
// a CSRF cookie primed on a prior request, which only works if cookies persist.
const cookieJar = new CookieJar();

// Direct egress (default). Used for sources reachable from our server IP, e.g.
// the ArcGIS dataset refresh.
export const impit = new Impit({
  browser: 'chrome',
  ignoreTlsErrors: true,
  cookieJar,
});

// Optional egress proxy for sources that block our datacenter IP by reputation
// regardless of TLS fingerprint (Transport Malta sits behind Cloudflare and
// 403s our Hetzner IP). Set SCRAPER_PROXY_URL to a `socks5h://` (remote-DNS
// SOCKS5 — required so the proxy, not us, resolves the target; a local-DNS
// `socks5://` leaks to IPv6 and fails), `http://` or `https://` proxy. In prod
// this points at a Cloudflare WARP proxy-mode sidecar. When unset, the proxied
// client falls back to the direct one, so callers never need to branch.
const proxyUrl = process.env.SCRAPER_PROXY_URL?.trim();
export const proxiedImpit = proxyUrl
  ? new Impit({
      browser: 'chrome',
      ignoreTlsErrors: true,
      cookieJar,
      proxyUrl,
    })
  : impit;

async function fetchTextWith(
  client: Impit,
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<string> {
  const res = await client.fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

async function fetchBufferWith(
  client: Impit,
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<Buffer> {
  const res = await client.fetch(url, init);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function fetchText(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<string> {
  return fetchTextWith(impit, url, init);
}

export function fetchBuffer(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<Buffer> {
  return fetchBufferWith(impit, url, init);
}

// Proxied variants — route through SCRAPER_PROXY_URL when configured, else
// identical to the direct helpers. Use these for sources that block our
// server IP (Transport Malta notice listings and PDFs).
export function fetchTextViaProxy(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<string> {
  return fetchTextWith(proxiedImpit, url, init);
}

export function fetchBufferViaProxy(
  url: string,
  init?: Parameters<typeof impit.fetch>[1],
): Promise<Buffer> {
  return fetchBufferWith(proxiedImpit, url, init);
}
