// Discovers active PDF notice URLs from Transport Malta's listing pages.
// Independent of the extraction pipeline — this only produces links.

import * as cheerio from 'cheerio';
import { fetchText } from '../../../common/utils/http';

export interface PdfLink {
  url: string;
  title: string;
  // Listing page the link was discovered on (one of SOURCES).
  source: string;
}

export const SOURCES: string[] = [
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners-93',
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners/local-notice-to-mariners-2336',
  'https://www.transport.gov.mt/maritime/coastal-notices-to-mariners/port-notices-2337',
];

function isPdfLink(url: URL): boolean {
  const pathname = url.pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return true;
  // Transport Malta serves PDFs via /include/filestreaming.asp?fileid=NNNNN
  if (
    pathname.endsWith('/filestreaming.asp') &&
    url.searchParams.has('fileid')
  ) {
    return true;
  }
  return false;
}

// data-expiredon is rendered as DD/MM/YYYY (or empty for never-expires).
function parseExpiry(raw: string): Date | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = +m[1];
  const month = +m[2];
  const year = +m[3];
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject silent JS rollover (e.g. 31/02/2026 → 03/03/2026).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function isActive(expiredOnAttr: string | undefined, now: Date): boolean {
  const raw = (expiredOnAttr ?? '').trim();
  if (raw === '') return true; // never-expires
  const expiry = parseExpiry(raw);
  if (!expiry) return true; // unparseable → don't drop, let it through
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return expiry.getTime() >= today.getTime();
}

function extractPdfLinks(
  html: string,
  base: string,
  now: Date = new Date(),
): PdfLink[] {
  const $ = cheerio.load(html);
  const baseUrl = new URL(base);
  const seen = new Map<string, PdfLink>();

  // The listing page must contain ul#noticeslist; if it doesn't, the page
  // structure changed or we hit a Cloudflare interstitial. Throw rather than
  // silently returning [] — that masks scrape failures as "nothing new".
  if ($('ul#noticeslist').length === 0) {
    throw new Error(
      `Listing page ${base} has no ul#noticeslist element — likely blocked or page structure changed`,
    );
  }

  $('ul#noticeslist > li').each((_, li) => {
    if (!isActive($(li).attr('data-expiredon'), now)) return;

    $(li)
      .find('a[href]')
      .each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        let url: URL;
        try {
          url = new URL(href, baseUrl);
        } catch {
          return;
        }

        if (!isPdfLink(url)) return;

        const absolute = url.toString();
        const title = ($(el).attr('title') || $(el).text() || '').trim();
        if (!seen.has(absolute)) {
          seen.set(absolute, { url: absolute, title, source: base });
        }
      });
  });

  return [...seen.values()];
}

async function fetchSource(source: string): Promise<PdfLink[]> {
  const html = await fetchText(source);
  return extractPdfLinks(html, source);
}

/**
 * Discover all currently-active PDF links across the configured listing pages.
 * Deduplicates by URL. Intended to be called by the scheduler/orchestrator,
 * which then enqueues one extraction job per returned link.
 */
export async function listNoticeLinks(): Promise<PdfLink[]> {
  const sourceResults = await Promise.allSettled(SOURCES.map(fetchSource));

  const links: PdfLink[] = [];
  const failures: string[] = [];
  sourceResults.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      links.push(...result.value);
    } else {
      const reason =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
      failures.push(`${SOURCES[i]}: ${reason}`);
    }
  });

  // Partial failure (some sources up, some down) is logged but not fatal.
  // Total failure means every listing page is unreachable — surface it so
  // the caller's error handler / alerting can fire.
  if (failures.length === SOURCES.length) {
    throw new Error(
      `All ${SOURCES.length} listing sources failed: ${failures.join(' | ')}`,
    );
  }

  const deduped = new Map<string, PdfLink>();
  for (const link of links) deduped.set(link.url, link);
  return [...deduped.values()];
}
