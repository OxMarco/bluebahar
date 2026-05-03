import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Weather } from '../scraper/entities/weather.entity';
import { Dataset } from '../scraper/entities/dataset.entity';
import { MapService } from './map.service';
import { MapController } from './map.controller';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeToMariners, Weather, Dataset])],
  controllers: [MapController],
  providers: [MapService],
})
export class MapModule {}
