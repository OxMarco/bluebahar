import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DATASETS, type DatasetDefinition } from './datasets';

// GeoJSON files are committed to the repo and shipped with the deploy artifact;
// resolved from process.cwd() since both `npm start` and the Dockerfile's
// WORKDIR /app put us at the project root.
const DATASETS_DIR = resolve(process.cwd(), 'data/datasets');

export interface DatasetMetadata {
  key: string;
  name: string;
  sourceUrl: string;
  featureCount: number;
  byteSize: number;
  sha256: string;
}

export interface DatasetEntry {
  metadata: DatasetMetadata;
  filePath: string;
}

@Injectable()
export class DatasetCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DatasetCatalogService.name);
  private readonly entries = new Map<string, DatasetEntry>();

  async onApplicationBootstrap() {
    for (const def of DATASETS) {
      const filePath = resolve(DATASETS_DIR, `${def.key}.geojson`);
      try {
        const entry = await this.loadEntry(def, filePath);
        this.entries.set(def.key, entry);
      } catch (err) {
        // A missing or malformed file shouldn't crash the whole app — the
        // notices endpoints stay useful even if a dataset is misconfigured.
        // Log + skip; the corresponding GET will 503.
        this.logger.error(
          `Failed to load dataset "${def.key}" from ${filePath}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `Loaded ${this.entries.size}/${DATASETS.length} dataset(s) from ${DATASETS_DIR}`,
    );
  }

  list(): DatasetMetadata[] {
    return [...this.entries.values()]
      .map((e) => e.metadata)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Resolves to a usable file path or throws an HTTP-typed exception. Splits
  // "unknown key" (404) from "definition exists but failed to load at boot"
  // (503) so callers can tell a typo from a server-side problem.
  requireEntry(key: string): DatasetEntry {
    const entry = this.entries.get(key);
    if (entry) return entry;
    if (DATASETS.some((d) => d.key === key)) {
      throw new ServiceUnavailableException(
        `Dataset "${key}" is unavailable; check server logs.`,
      );
    }
    throw new NotFoundException(`Unknown dataset: ${key}`);
  }

  private async loadEntry(
    def: DatasetDefinition,
    filePath: string,
  ): Promise<DatasetEntry> {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as {
      type?: string;
      features?: unknown[];
    };
    if (
      parsed.type !== 'FeatureCollection' ||
      !Array.isArray(parsed.features)
    ) {
      throw new Error(
        `Expected GeoJSON FeatureCollection, got type=${parsed.type ?? 'undefined'}`,
      );
    }
    return {
      filePath,
      metadata: {
        key: def.key,
        name: def.name,
        sourceUrl: def.sourceUrl,
        featureCount: parsed.features.length,
        byteSize: Buffer.byteLength(raw, 'utf8'),
        sha256: createHash('sha256').update(raw).digest('hex'),
      },
    };
  }
}
