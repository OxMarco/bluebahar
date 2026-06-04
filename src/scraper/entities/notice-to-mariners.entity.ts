import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
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
export class NoticeToMariners {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'enum', enum: NoticeKind })
  kind!: NoticeKind;

  @Column()
  title!: string;

  @Column()
  description!: string;

  @Column()
  source!: string;

  // Disambiguates multiple notices extracted from a single PDF. Empty string
  // when the PDF maps to one notice; otherwise a stable section identifier.
  // Unique together with `source` so retries don't duplicate rows.
  @Column({ default: '' })
  subKey!: string;

  // Required for kind='facility', optional context for kind='area', absent for 'advisory'.
  @Column({ nullable: true })
  locationLabel?: string;

  // Distinct geographic parts. The API serializer (notice-serializer.ts) maps
  // this into a single GeoJSON geometry per notice (or GeometryCollection when
  // there are multiple parts).
  @Column({ type: 'jsonb', default: () => "'[]'" })
  areas!: NoticeGeometryPart[];

  // Safety berth radius from the hazard, in metres. Top-level (one notice =
  // one safety distance); the polygon's vertices in `area` carry only the
  // geometry. Null when the notice does not specify one.
  @Column({ type: 'float', nullable: true })
  distance?: number;

  // Depth of the hazard itself in metres (e.g. wreck depth below sea level).
  // Null when not stated.
  @Column({ type: 'float', nullable: true })
  depth?: number;

  @Column({ type: 'timestamp' })
  publishedAt!: Date;

  @Index()
  @Column({ type: 'timestamp' })
  activeFrom!: Date;

  @Index()
  @Column({ type: 'timestamp', nullable: true })
  activeTo?: Date; // null means "no expiry"

  @Index()
  @Column({ default: false })
  needsReview!: boolean;

  // Machine-readable reasons why `needsReview` was set. Kept so the admin review
  // queue can explain what looked suspicious instead of showing only a boolean.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  reviewReasons!: string[];

  @Column({ default: 0 })
  reports!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
