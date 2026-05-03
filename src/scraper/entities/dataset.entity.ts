import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class Dataset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  key!: string;

  @Column()
  name!: string;

  @Column()
  sourceUrl!: string;

  @Column()
  filePath!: string;

  // sha256 hex of the stored GeoJSON; used to short-circuit re-writes.
  @Column({ length: 64 })
  sha256!: string;

  @Column({ type: 'int' })
  featureCount!: number;

  @Column({ type: 'int' })
  byteSize!: number;

  @Column({ type: 'timestamp' })
  fetchedAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
