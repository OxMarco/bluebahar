// Batch validation: run extraction over many notices, summarize geometry outcomes.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listNoticeLinks } from '../src/scraper/parser/notice-to-mariners/listing';
import { extractNoticeFromBuffer } from '../src/scraper/parser/notice-to-mariners/extract';
import { readPdfTextFromBuffer } from '../src/scraper/parser/notice-to-mariners/core';
import { fetchBufferViaProxy } from '../src/common/utils/http';

const OUT = '/tmp/ntm-validation';

async function main() {
  const count = Number(process.argv[2] ?? 20);
  mkdirSync(OUT, { recursive: true });

  const links = await listNoticeLinks();
  const shuffled = [...links].sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, count);

  for (const link of picked) {
    const safe = (link.title || link.url)
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .slice(0, 60);
    const pdfPath = join(OUT, `${safe}.pdf`);
    try {
      let buffer: Buffer;
      if (existsSync(pdfPath)) {
        buffer = readFileSync(pdfPath);
      } else {
        buffer = await fetchBufferViaProxy(link.url);
        writeFileSync(pdfPath, buffer);
      }
      const { text } = await readPdfTextFromBuffer(buffer);
      writeFileSync(join(OUT, `${safe}.txt`), text);
      const parsed = await extractNoticeFromBuffer(buffer, link.url, null, {
        enrich: false,
        listingTitle: link.title,
      });
      writeFileSync(
        join(OUT, `${safe}.json`),
        JSON.stringify({ link, parsed }, null, 2),
      );
      const p = parsed[0];
      const geoms = (p.areas as any[]).map(
        (a) => `${a.geometryType}(${a.points?.length ?? 0})`,
      );
      console.log(
        `${p.areas.length > 0 ? 'GEO ' : '    '}${safe} | review=${p.needsReview} | ${geoms.join(', ')}${p.reviewReasons.length ? ' | ' + p.reviewReasons.join(';') : ''}`,
      );
    } catch (err) {
      console.error(`FAIL ${safe}: ${err}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
