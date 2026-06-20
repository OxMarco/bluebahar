import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Logs } from './entities/logs.entity';

@Injectable()
export class LogRetentionService {
  private static readonly RETENTION_DAYS = 14;
  private readonly logger = new Logger(LogRetentionService.name);

  constructor(
    @InjectRepository(Logs)
    private readonly logsRepository: Repository<Logs>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async pruneOldLogs(): Promise<void> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - LogRetentionService.RETENTION_DAYS);
    const result = await this.logsRepository.delete({
      createdAt: LessThan(cutoff),
    });
    this.logger.log(
      `Pruned ${result.affected ?? 0} log(s) older than ${LogRetentionService.RETENTION_DAYS} days`,
    );
  }
}
