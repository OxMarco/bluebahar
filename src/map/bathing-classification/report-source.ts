import { Impit } from 'impit';

// The Environmental Health Directorate's Bathing Water Programme landing page,
// which links the weekly "Site Classification Update Report" PDF among the
// season's reports. Hardcoded — the only configurable knob is the enable flag.
export const DEFAULT_REPORT_PAGE_URL =
  'https://environmentalhealth.gov.mt/en/ehs/wrau/bathing-water-programme/';

const FETCH_TIMEOUT_MS = 30_000;

// The EHD site sits behind Cloudflare Bot Management, which 403s plain HTTP
// clients on their TLS/HTTP2 fingerprint — browser-like headers alone don't
// pass. impit impersonates a real Chrome fingerprint, which does. One instance
// is reused across calls (shared connection pool); created lazily so importing
// this module (e.g. for the pure pickLatestReportUrl) doesn't spin up the
// native client.
let client: Impit | undefined;
function impit(): Impit {
  if (!client) {
    client = new Impit({ browser: 'chrome', timeout: FETCH_TIMEOUT_MS });
  }
  return client;
}

async function fetchText(url: string): Promise<string> {
  const response = await impit().fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return response.text();
}

async function fetchPdf(url: string): Promise<Buffer> {
  const response = await impit().fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export interface FetchedReport {
  // Raw PDF bytes for the LLM file input.
  pdf: Buffer;
  // The resolved PDF URL, recorded for provenance.
  url: string;
}

// Resolve and download the latest classification report PDF: scrape the EHD
// programme page for the most recent "Site Classification Update Report" link,
// then fetch it.
export async function fetchLatestReport(): Promise<FetchedReport> {
  const html = await fetchText(DEFAULT_REPORT_PAGE_URL);
  const url = pickLatestReportUrl(html, DEFAULT_REPORT_PAGE_URL);
  if (!url) {
    throw new Error(
      `No classification report PDF found on ${DEFAULT_REPORT_PAGE_URL}`,
    );
  }
  return { pdf: await fetchPdf(url), url };
}

// Scrape the landing page for PDF links that look like the weekly classification
// report, then pick the newest by its WordPress upload month and report week.
// Exported for testing.
export function pickLatestReportUrl(
  html: string,
  baseUrl: string,
): string | null {
  const candidates: { url: string; uploadRank: string; week: number }[] = [];
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, ' ');
    if (!/\.pdf(?:[?#]|$)/i.test(href)) continue;
    if (!looksLikeClassificationReport(href, text)) continue;
    const url = absoluteUrl(href, baseUrl);
    if (!url) continue;
    candidates.push({
      url,
      uploadRank: uploadDateKey(url),
      week: reportWeek(`${href} ${text}`),
    });
  }
  if (candidates.length === 0) return null;
  // Weekly reports in the same month share a WordPress YYYY/MM path. Use the
  // report's week number as the tie-breaker instead of relying on DOM order.
  candidates.sort(
    (a, b) => a.uploadRank.localeCompare(b.uploadRank) || a.week - b.week,
  );
  return candidates[candidates.length - 1].url;
}

function looksLikeClassificationReport(href: string, text: string): boolean {
  const haystack = `${href} ${text}`.toLowerCase();
  return (
    haystack.includes('classification') ||
    (haystack.includes('site') && haystack.includes('update')) ||
    (haystack.includes('bathing') && haystack.includes('report'))
  );
}

// "/wp-content/uploads/2026/06/report.pdf" → "2026/06"; falls back to the whole
// URL so undated links still sort deterministically (just never above a dated
// one with a later year/month).
function uploadDateKey(url: string): string {
  const m = url.match(/\/uploads\/(\d{4})\/(\d{2})\//);
  return m ? `${m[1]}/${m[2]}` : `0000/00 ${url}`;
}

function reportWeek(value: string): number {
  const match = value.match(/\bweek(?:[-_\s]*)(\d{1,2})\b/i);
  return match ? Number(match[1]) : 0;
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}
