import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminService } from './admin.service';
import { AdminViewController } from './admin-view.controller';
import { AdminJwtGuard } from './admin-jwt.guard';
import { NoticeToMariners } from '../map/entities/notice-to-mariners.entity';
import { UserReport } from '../map/entities/user-report.entity';
import { Logs } from '../common/entities/logs.entity';
import { MapModule } from '../map/map.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([NoticeToMariners, UserReport, Logs]),
    MapModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('ADMIN_JWT_SECRET'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AdminViewController],
  providers: [AdminService, AdminJwtGuard],
})
export class AdminModule {}
