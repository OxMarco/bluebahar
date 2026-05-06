import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { DatasetCatalogService } from './dataset-catalog.service';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeToMariners])],
  controllers: [MapController],
  providers: [MapService, DatasetCatalogService],
})
export class MapModule {}
