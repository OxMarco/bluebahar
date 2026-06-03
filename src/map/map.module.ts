import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Logs } from '../scraper/entities/logs.entity';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { DatasetCatalogService } from './dataset-catalog.service';
import { DatasetRefreshService } from './dataset-refresh.service';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeToMariners, Logs])],
  controllers: [MapController],
  providers: [MapService, DatasetCatalogService, DatasetRefreshService],
  exports: [DatasetCatalogService, MapService],
})
export class MapModule {}
