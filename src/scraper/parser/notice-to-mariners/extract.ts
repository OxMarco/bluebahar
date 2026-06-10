// Orchestrates the vendored mariner-parser pipeline and maps its output onto the
// backend's ParsedNotice model:
//
//   PDF buffer
//     -> deterministic PDF text (core.readPdfTextFromBuffer)
//     -> deterministic regex extraction + geometry kinds (regex-strategy.runRegex)
//     -> plottable GeoJSON, incl. coastline closure / circles / outlier guarding
//        (geometry.buildFeatureCollection)
//     -> optional AI enrichment (category + summary; never coordinates)
//     -> ParsedNotice[] (adapter.adaptToParsedNotice)
//
// Coordinates and geometry are ALWAYS deterministic; the LLM only enriches the
// human-readable description/locations, so a sign flip or DMS error can never
// reach the database via the model.
import OpenAI from 'openai';
import { fetchBufferViaProxy } from '../../../common/utils/http';
import { errorMessage } from '../../../common/utils/error-message';
import { basename, readPdfTextFromBuffer } from './core';
import { runRegex } from './regex-strategy';
import { buildFeatureCollection } from './geometry';
import { enrichNotice, type Enrichment } from './enrich';
import {
  hasVerifiableGeometry,
  verifyExtractionWithVision,
} from './vision-verify';
import {
  adaptToParsedNotice,
  noticeExpiry,
  type ParsedNotice,
} from './adapter';

export interface ExtractOptions {
  // Run the AI enrichment step (category + summary). Defaults to true when an
  // OpenAI client is supplied; set false for fully offline/deterministic runs.
  enrich?: boolean;
  // Model for the enrichment call. Defaults to the ENRICH_MODEL/OPENAI_MODEL
  // env fallback chain in enrich.ts; the processor passes the validated
  // config value.
  enrichModel?: string;
  // Cross-check the extracted geometry against the PDF's chart pages with a
  // vision model (vision-verify.ts). The model never produces geometry; a
  // mismatch only flags the notice for manual review. Opt-in (defaults false)
  // because it costs one image-bearing model call per geometry notice.
  visionVerify?: boolean;
  // Model for the vision call; falls back to the VISION_MODEL/ENRICH_MODEL/
  // OPENAI_MODEL env chain in vision-verify.ts.
  visionModel?: string;
  // Wall-clock reference for the already-expired check. Defaults to now;
  // injectable for deterministic tests.
  now?: Date;
  // Anchor text from the listing page link (PdfLink.title), used as a
  // human-readable title fallback when the PDF yields no title/reference.
  listingTitle?: string;
}

export async function extractNoticeFromPdf(
  url: string,
  openai: OpenAI,
  opts: ExtractOptions = {},
): Promise<ParsedNotice[]> {
  const buffer = await fetchBufferViaProxy(url);
  return extractNoticeFromBuffer(buffer, url, openai, opts);
}

// Buffer-based variant for offline testing (CLI scripts, fixtures). `source` is
// what gets stored on the ParsedNotice (and what unique(source, subKey) uses) —
// pass the canonical URL when available, or a stable file identifier. Pass
// `openai` as null with no enrichment for a fully deterministic run.
export async function extractNoticeFromBuffer(
  buffer: Buffer | Uint8Array,
  source: string,
  openai: OpenAI | null,
  opts: ExtractOptions = {},
): Promise<ParsedNotice[]> {
  const { text, pages } = await readPdfTextFromBuffer(buffer);
  const { extraction, meta } = runRegex(text, pages, basename(source));

  // Notices whose validity window has already lapsed are still persisted: the
  // row's past activeTo hides it from public getters, and the stored `source`
  // is what dedups the URL out of future scrape cycles — dropping it here would
  // leave the URL outside storedUrls, so every cron run would re-enqueue and
  // re-parse it forever, consuming batch slots that newer notices need. Only
  // the LLM enrichment is skipped (nothing will ever display it). Validity is
  // extracted deterministically by runRegex, so this needs no LLM call.
  const expiry = noticeExpiry(extraction);
  const now = opts.now ?? new Date();
  const alreadyExpired = expiry !== null && expiry.getTime() < now.getTime();

  const featureCollection = buildFeatureCollection(extraction);

  const notes = [...meta.notes];

  // Enrichment is opt-in and best-effort: a failed LLM call must not lose the
  // deterministic geometry, so we note it and fall back to a rule-based
  // description in the adapter.
  let enrichment: Enrichment | null = null;
  if (openai && (opts.enrich ?? true) && !alreadyExpired) {
    try {
      enrichment = await enrichNotice(
        openai,
        text,
        extraction,
        opts.enrichModel,
      );
    } catch (err) {
      notes.push(`enrichment_failed:${errorMessage(err)}`);
    }
  }

  // Vision cross-check: the chart attached to the notice is the authoritative
  // picture of every zone, so a vision model comparing it against the
  // deterministic shapes catches topology mistakes (merged zones, wrong
  // closure side, a sector flattened to points) that no text rule can see.
  // Best-effort like enrichment: only a 'mismatch' verdict has any effect, and
  // it only ADDS a review flag — geometry itself is never touched.
  if (
    openai &&
    (opts.visionVerify ?? false) &&
    !alreadyExpired &&
    hasVerifiableGeometry(extraction)
  ) {
    try {
      const verdict = await verifyExtractionWithVision(
        openai,
        buffer,
        extraction,
        featureCollection,
        opts.visionModel,
      );
      if (verdict.verdict === 'mismatch') {
        notes.push(
          `vision_mismatch:${verdict.discrepancies.join(' | ') || verdict.summary}`,
        );
      } else {
        notes.push(`vision_${verdict.verdict}:${verdict.summary}`);
      }
    } catch (err) {
      notes.push(`vision_verify_failed:${errorMessage(err)}`);
    }
  }

  return [
    adaptToParsedNotice({
      source,
      extraction,
      featureCollection,
      enrichment,
      notes,
      listingTitle: opts.listingTitle,
    }),
  ];
}
