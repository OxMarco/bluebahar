import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { TerminusModule } from '@nestjs/terminus';
import { CacheModule } from '@nestjs/cache-manager';
import { createKeyv } from '@keyv/redis';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { validateConfig } from './config.schema';
import { ScraperModule } from './scraper/scraper.module';
import { MapModule } from './map/map.module';
import { AppController } from './app.controller';
import { ImpitHealthIndicator } from './common/health/impit-health.indicator';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { TypeOrmNotFoundExceptionFilter } from './common/filters/entity-not-found.filter';
import { AdminModule } from './admin/admin.module';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateConfig,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => [
        {
          ttl: configService.getOrThrow<number>('THROTTLE_TTL_MS'),
          limit: configService.getOrThrow<number>('THROTTLE_LIMIT'),
        },
      ],
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.getOrThrow<string>('DB_HOST'),
        port: configService.getOrThrow<number>('DB_PORT'),
        username: configService.getOrThrow<string>('DB_USERNAME'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.getOrThrow<string>('DB_NAME'),
        autoLoadEntities: true,
        // Auto-sync schema from entities on boot. Restarts/crashes preserve
        // data; for breaking entity changes that synchronize can't reconcile,
        // wipe the postgres volume manually (`docker compose down -v`).
        synchronize: true,
      }),
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.getOrThrow<string>('REDIS_HOST'),
          port: configService.getOrThrow<number>('REDIS_PORT'),
        },
      }),
      inject: [ConfigService],
    }),
    // Global cache backed by the same Redis we already run, so the TTL'd entries
    // are shared across instances rather than per-process. Namespaced to keep
    // its keys clear of the BullMQ queue data sharing the Redis db.
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        stores: [
          createKeyv(
            `redis://${configService.getOrThrow<string>(
              'REDIS_HOST',
            )}:${configService.getOrThrow<number>('REDIS_PORT')}`,
            { namespace: 'cache' },
          ),
        ],
        ttl: configService.getOrThrow<number>('MAP_CACHE_TTL_MS'),
      }),
      inject: [ConfigService],
    }),
    TerminusModule.forRoot(),
    SentryModule.forRoot(),
    ScraperModule,
    MapModule,
    AdminModule,
  ],
  providers: [
    // Nest REVERSES this list before dispatch and uses the first @Catch match,
    // so the effective order is TypeOrmNotFoundExceptionFilter ->
    // ApiExceptionFilter -> SentryGlobalFilter. The Sentry filter therefore
    // only sees non-HttpException errors; ApiExceptionFilter reports its own
    // 5xx to Sentry. Don't reorder without rechecking both.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_FILTER, useClass: TypeOrmNotFoundExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    ImpitHealthIndicator,
  ],
})
export class AppModule {}
