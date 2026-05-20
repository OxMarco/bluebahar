import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { NoticeToMariners } from '../scraper/entities/notice-to-mariners.entity';
import { Logs } from '../scraper/entities/logs.entity';
import { MapModule } from '../map/map.module';

@Module({
  imports: [TypeOrmModule.forFeature([NoticeToMariners, Logs]), MapModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
