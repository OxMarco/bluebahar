import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { NoticeKind } from '../notice-kind';

@Entity()
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

  @Column({ unique: true })
  source!: string;

  // Required for kind='facility', optional context for kind='area', absent for 'advisory'.
  @Column({ nullable: true })
  locationLabel?: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  area!: { lat: number; long: number; depth?: number; distance?: number }[];

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

  @CreateDateColumn()
  createdAt!: Date;
}
