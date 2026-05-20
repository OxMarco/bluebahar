import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LogType } from '../log-type';

@Entity()
// viewLogs filters by logType and createdAt and orders by createdAt; the
// composite index covers both the type-filtered and recency-ordered reads.
@Index(['logType', 'createdAt'])
export class Logs {
  @PrimaryGeneratedColumn('increment')
  id!: bigint;

  @Column({ type: 'enum', enum: LogType })
  logType!: LogType;

  @Column()
  description!: string;

  @Index()
  @CreateDateColumn()
  createdAt!: Date;
}
