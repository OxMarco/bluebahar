import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { CLASSIFICATIONS, type Classification } from './classification';

// One bathing site's latest EU water-quality classification, keyed by the same
// Site_Code the beaches dataset carries (A01…D23). The weekly importer upserts
// these; DatasetCatalogService merges them onto beach features at build time.
// Persisted (not in-memory only) so a restart keeps the last classifications
// even before the next network refresh — and so the data survives an EHD source
// outage that would otherwise leave beaches unclassified.
@Entity()
export class BathingWaterClassification {
  // Canonical Site_Code (upper-case, no spaces). The natural key — one row per
  // site — so re-imports upsert in place.
  @PrimaryColumn()
  siteCode!: string;

  @Column({ type: 'enum', enum: CLASSIFICATIONS })
  classification!: Classification;

  @Column({ default: false })
  healthWarning!: boolean;

  // The report's publication date, e.g. "1 June 2026". Shown in the beach detail
  // row so users can judge how current the rating is.
  @Column({ nullable: true })
  publishedOn?: string;

  // The report URL this classification was parsed from, for the admin audit
  // trail / provenance. Null when imported from an explicitly configured URL
  // with no public landing page.
  @Column({ nullable: true })
  sourceUrl?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
