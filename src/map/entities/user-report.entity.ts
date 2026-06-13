import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

// A crowd-sourced report a boater filed against a point on the map (a wreck, a
// hazard, something wrong). Unlike a notice "report" — which only increments a
// counter on an existing NoticeToMariners row — this is free-form user content,
// so it lives in its own table and is only ever surfaced to admins for triage.
@Entity()
// The admin queue reads open reports newest-first; this composite serves the
// resolved filter + the createdAt sort in one index scan.
@Index(['resolved', 'createdAt'])
export class UserReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255 })
  title!: string;

  // Free-form; text rather than varchar to make the unbounded intent explicit
  // (length is bounded at the DTO instead).
  @Column({ type: 'text' })
  description!: string;

  // The tapped point the report is about — not necessarily the reporter's own
  // position. double precision so coordinates keep full precision (the `float`
  // alias maps to 4-byte real, which loses ~metres).
  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  // Cleared by default; an admin flips it once the report has been actioned.
  // Kept (rather than deleted) so resolved reports stay auditable.
  @Column({ default: false })
  resolved!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
