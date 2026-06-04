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
import { fetchBuffer } from '../../../common/utils/http';
import { basename, readPdfTextFromBuffer } from './core';
import { runRegex } from './regex-strategy';
import { buildFeatureCollection } from './geometry';
import { enrichNotice, type Enrichment } from './enrich';
import {
  adaptToParsedNotice,
  noticeExpiry,
  type ParsedNotice,
} from './adapter';

export interface ExtractOptions {
  // Run the AI enrichment step (category + summary). Defaults to true when an
  // OpenAI client is supplied; set false for fully offline/deterministic runs.
  enrich?: boolean;
  // Wall-clock reference for the already-expired check. Defaults to now;
  // injectable for deterministic tests.
  now?: Date;
}

export async function extractNoticeFromPdf(
  url: string,
  openai: OpenAI,
  opts: ExtractOptions = {},
): Promise<ParsedNotice[]> {
  const buffer = await fetchBuffer(url);
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

  // Discard notices whose validity window has already lapsed before the
  // expensive enrichment + storage steps. Validity is extracted deterministically
  // by runRegex, so this needs no PDF re-read or LLM call. Notices that never
  // expire (or whose expiry we couldn't extract) have no valid_to and fall
  // through. The listing page already drops most expired notices via
  // data-expiredon; this catches the ones whose real expiry only the PDF states.
  const expiry = noticeExpiry(extraction);
  const now = opts.now ?? new Date();
  if (expiry && expiry.getTime() < now.getTime()) {
    return [];
  }

  const featureCollection = buildFeatureCollection(extraction);

  const notes = [...meta.notes];

  // Enrichment is opt-in and best-effort: a failed LLM call must not lose the
  // deterministic geometry, so we note it and fall back to a rule-based
  // description in the adapter.
  let enrichment: Enrichment | null = null;
  if (openai && (opts.enrich ?? true)) {
    try {
      enrichment = await enrichNotice(openai, text, extraction);
    } catch (err) {
      notes.push(
        `enrichment_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return [
    adaptToParsedNotice({
      source,
      extraction,
      featureCollection,
      enrichment,
      notes,
    }),
  ];
}
