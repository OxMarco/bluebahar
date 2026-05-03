import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScraperService } from './scraper.service';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { Weather } from './entities/weather.entity';
import { Dataset } from './entities/dataset.entity';
import { ScraperProcessor } from './scraper.processor';
import { BullModule } from '@nestjs/bull';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoticeToMariners, Weather, Dataset]),
    HttpModule.register({ timeout: 15000, maxRedirects: 5 }),
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
  providers: [ScraperService, ScraperProcessor],
  exports: [ScraperService],
})
export class ScraperModule {}
