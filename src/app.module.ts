import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TerminusModule } from '@nestjs/terminus';
import { SentryGlobalFilter, SentryModule } from '@sentry/nestjs/setup';
import { configValidationSchema } from './config.schema';
import { ScraperModule } from './scraper/scraper.module';
import { MapModule } from './map/map.module';
import { AppController } from './app.controller';
import { ImpitHealthIndicator } from './common/health/impit-health.indicator';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';
import { TypeOrmNotFoundExceptionFilter } from './common/filters/entity-not-found.filter';

@Module({
  controllers: [AppController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configValidationSchema,
      validationOptions: { abortEarly: false },
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
    EventEmitterModule.forRoot(),
    TerminusModule.forRoot(),
    SentryModule.forRoot(),
    ScraperModule,
    MapModule,
  ],
  providers: [
    // Sentry filter is registered first so it captures errors before other
    // filters respond. TypeOrmNotFoundExceptionFilter is @Catch(EntityNotFoundError)
    // and still wins for that specific type — Nest dispatches to the most specific match.
    { provide: APP_FILTER, useClass: SentryGlobalFilter },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_FILTER, useClass: TypeOrmNotFoundExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    ImpitHealthIndicator,
  ],
})
export class AppModule {}
