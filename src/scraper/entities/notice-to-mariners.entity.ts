import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { NoticeKind } from '../notice-kind';

type NoticeGeometryType = 'point' | 'line' | 'polygon';
type NoticePoint = { lat: number; long: number };
type NoticeGeometryPart = {
  label: string;
  geometryType: NoticeGeometryType;
  points: NoticePoint[];
};

@Entity()
@Unique(['source', 'subKey'])
// The dominant public read (MapService.getNotices) filters needsReview and
// orders/ranges on activeFrom; this composite serves the filter + sort + LIMIT
// in one index scan, and also covers the admin review queue (needsReview=true).
// Low-selectivity singletons (kind, the needsReview boolean) are deliberately
// omitted — the planner wouldn't use them, and they'd only tax every insert.
@Index(['needsReview', 'activeFrom'])
export class NoticeToMariners {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: NoticeKind })
  kind!: NoticeKind;

  @Column()
  title!: string;

  // Multi-paragraph AI summary + recommended action; text rather than the
  // default varchar to make the unbounded intent explicit.
  @Column({ type: 'text' })
  description!: string;

  @Column()
  source!: string;

  // Disambiguates multiple notices extracted from a single PDF. Empty string
  // when the PDF maps to one notice; otherwise a stable section identifier.
  // Unique together with `source` so retries don't duplicate rows.
  @Column({ default: '' })
  subKey!: string;

  // Human-readable place name (e.g. 'Pembroke Ranges'); absent when the notice
  // names no location. Orthogonal to `kind` — either kind may carry one.
  @Column({ nullable: true })
  locationLabel?: string;

  // Distinct geographic parts. The API serializer (notice-serializer.ts) maps
  // this into a GeoJSON FeatureCollection with one Feature per part (Mapbox GL
  // won't render GeometryCollections).
  @Column({ type: 'jsonb', default: () => "'[]'" })
  areas!: NoticeGeometryPart[];

  // Safety berth radius from the hazard, in metres. Top-level (one notice =
  // one safety distance); the polygon's vertices in `area` carry only the
  // geometry. Null when the notice does not specify one.
  @Column({ type: 'float', nullable: true })
  distance?: number;

  // All instants are timestamptz: every comparison in the service layer is
  // against a UTC `new Date()`, so the column must store a true instant rather
  // than a tz-naive wall clock the driver could reinterpret.
  @Column({ type: 'timestamptz' })
  publishedAt!: Date;

  @Column({ type: 'timestamptz' })
  activeFrom!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  activeTo?: Date; // null means "no expiry"

  @Column({ default: false })
  needsReview!: boolean;

  // Machine-readable reasons why `needsReview` was set. Kept so the admin review
  // queue can explain what looked suspicious instead of showing only a boolean.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  reviewReasons!: string[];

  @Column({ default: 0 })
  reports!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  // Touched on every write (approve, dismiss-reports, report increment, …).
  // The cache manifest's notices.rev hashes MAX(updatedAt) — createdAt alone
  // misses review-flag flips, which don't create rows.
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
