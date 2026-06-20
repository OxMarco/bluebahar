import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { NoticeToMariners } from './entities/notice-to-mariners.entity';
import { UserReport } from './entities/user-report.entity';
import { Logs } from '../common/entities/logs.entity';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { DatasetCatalogService } from './dataset-catalog.service';
import { DatasetRefreshService } from './dataset-refresh.service';
import { CommunityMapImportService } from './community-map/community-map-import.service';
import { LogRetentionService } from '../common/log-retention.service';
import {
  COMMUNITY_MAP_IMPORT_QUEUE,
  CommunityMapImportScheduler,
} from './community-map/community-map-import.scheduler';
import { CommunityMapImportProcessor } from './community-map/community-map-import.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoticeToMariners, UserReport, Logs]),
    BullModule.registerQueue({
      name: COMMUNITY_MAP_IMPORT_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 30,
      },
    }),
  ],
  controllers: [MapController],
  providers: [
    MapService,
    DatasetCatalogService,
    DatasetRefreshService,
    CommunityMapImportService,
    CommunityMapImportScheduler,
    CommunityMapImportProcessor,
    LogRetentionService,
  ],
  exports: [DatasetCatalogService, MapService],
})
export class MapModule {}
