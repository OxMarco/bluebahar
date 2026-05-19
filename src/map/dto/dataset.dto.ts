import type { DatasetKind } from '../datasets';

export class DatasetDto {
  key!: string;
  name!: string;
  kind!: DatasetKind;
  sourceUrl!: string;
  featureCount!: number;
  geometryTypes!: string[];
  bbox?: [number, number, number, number];
  byteSize!: number;
  sha256!: string;
}
