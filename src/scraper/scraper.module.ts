import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScraperService } from './scraper.service';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { ScraperProcessor } from './scraper.processor';
import { BullModule } from '@nestjs/bullmq';
import { RedisHealthIndicator } from '../common/health/redis-health.indicator';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoticeToMariners]),
    BullModule.registerQueue({
      name: 'scraper',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  providers: [ScraperService, ScraperProcessor, RedisHealthIndicator],
  exports: [ScraperService, RedisHealthIndicator],
})
export class ScraperModule {}
