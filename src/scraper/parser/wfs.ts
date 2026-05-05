import { createHash } from 'node:crypto';
import { fetchHtml } from '../../common/utils/http';

export interface FetchedDataset {
  geojson: string;
  sha256: string;
  featureCount: number;
  byteSize: number;
}

// Normalize any WFS URL: force GeoJSON output and drop pagination caps.
function normalizeWfsUrl(raw: string): string {
  const url = new URL(raw);
  url.searchParams.delete('count');
  url.searchParams.delete('COUNT');
  url.searchParams.delete('maxFeatures');
  url.searchParams.delete('MAXFEATURES');
  url.searchParams.set('outputFormat', 'application/json');
  return url.toString();
}

export async function fetchWfsDataset(
  sourceUrl: string,
): Promise<FetchedDataset> {
  const body = await fetchHtml(normalizeWfsUrl(sourceUrl), {
    timeout: 120_000,
  });

  const parsed = JSON.parse(body) as {
    type?: string;
    features?: unknown[];
  };
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(
      `Expected GeoJSON FeatureCollection from ${sourceUrl}, got type=${parsed.type ?? 'undefined'}`,
    );
  }

  // All configured datasets are static reference geographies; a zero-feature
  // response means the upstream WFS broke or the layer was retired, not
  // genuinely empty data. Surface it rather than overwriting the on-disk file
  // with an empty FeatureCollection.
  if (parsed.features.length === 0) {
    throw new Error(
      `WFS endpoint ${sourceUrl} returned an empty FeatureCollection — likely upstream failure`,
    );
  }

  const sha256 = createHash('sha256').update(body).digest('hex');
  return {
    geojson: body,
    sha256,
    featureCount: parsed.features.length,
    byteSize: Buffer.byteLength(body, 'utf8'),
  };
}
