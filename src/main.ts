import './instrument';
import * as Sentry from '@sentry/nestjs';
import { NestFactory, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  ValidationPipe,
  HttpStatus,
  ValidationError,
  UnprocessableEntityException,
  ClassSerializerInterceptor,
  Logger,
  VersioningType,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import hbs from 'hbs';
import { DateTime } from 'luxon';
import { join } from 'node:path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    cors: true,
  });
  const reflector = app.get(Reflector);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      transform: true,
      dismissDefaultMessages: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const messages = errors.flatMap((error) =>
          Object.values(error.constraints ?? {}),
        );
        return new UnprocessableEntityException(messages);
      },
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));
  // Gzip/deflate responses. The big win is the GeoJSON datasets and notice
  // collections served under /v1/map — large, highly compressible JSON.
  app.use(compression());
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://cdn.tailwindcss.com',
            'https://unpkg.com',
          ],
          'script-src-elem': [
            "'self'",
            "'unsafe-inline'",
            'https://cdn.tailwindcss.com',
            'https://unpkg.com',
          ],
          'style-src': [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
            'https://unpkg.com',
          ],
          'style-src-elem': [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
            'https://unpkg.com',
          ],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': [
            "'self'",
            'data:',
            'https://tile.openstreetmap.org',
            'https://*.tile.openstreetmap.org',
            'https://unpkg.com',
          ],
        },
      },
    }),
  );
  app.use(
    '/admin',
    helmet.contentSecurityPolicy({
      useDefaults: true,
      directives: {
        // 'unsafe-eval' is required by Alpine.js, which compiles x-data and
        // directive expressions via the Function constructor.
        'script-src': ["'self'", 'https://unpkg.com', "'unsafe-eval'"],
        'script-src-elem': ["'self'", 'https://unpkg.com'],
        'style-src': ["'self'", 'https://unpkg.com'],
        'style-src-elem': ["'self'", 'https://unpkg.com'],
        'font-src': ["'self'"],
        'img-src': [
          "'self'",
          'data:',
          'https://tile.openstreetmap.org',
          'https://*.tile.openstreetmap.org',
          'https://unpkg.com',
        ],
        'connect-src': ["'self'"],
      },
    }),
  );
  app.use(cookieParser());
  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.setBaseViewsDir(join(__dirname, '..', 'views'));
  app.setViewEngine('hbs');
  (
    hbs.registerPartials as unknown as (
      directory: string,
      options: { rename: (name: string) => string },
    ) => void
  )(join(__dirname, '..', 'views', 'partials'), {
    rename: (name: string) => name,
  });
  hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  // Stringify a value for safe embedding in an HTML data block (e.g. inside
  // `<script type="application/json">`). Escapes the `<` so a stray `</script>`
  // in user data can't break out of the block.
  hbs.registerHelper('json', (value: unknown) =>
    JSON.stringify(value ?? null).replace(/</g, '\\u003c'),
  );
  hbs.registerHelper('add', (a: unknown, b: unknown) => Number(a) + Number(b));
  // Coerce a Date | ISO string | epoch number into a luxon DateTime, or null if
  // it isn't a usable date. Shared by the formatting helpers below.
  const toDateTime = (value: unknown): DateTime | null => {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
      const dt = DateTime.fromJSDate(value);
      return dt.isValid ? dt : null;
    }
    if (typeof value === 'number') {
      const dt = DateTime.fromMillis(value);
      return dt.isValid ? dt : null;
    }
    if (typeof value === 'string') {
      const dt = DateTime.fromISO(value);
      return dt.isValid ? dt : null;
    }
    return null;
  };
  // Human-readable timestamp for the admin tables, e.g. "19 Jun 2026, 23:41".
  // Falls back to the raw value so a malformed date is still visible, not blank.
  hbs.registerHelper('formatDate', (value: unknown) => {
    const dt = toDateTime(value);
    if (dt) return dt.toFormat('dd LLL yyyy, HH:mm');
    // Show the raw value only when it's a primitive worth displaying; objects
    // would stringify to a useless '[object Object]', so blank those.
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';
  });
  // Relative phrasing for activity feeds, e.g. "2 hours ago". Empty for non-dates.
  hbs.registerHelper('formatRelative', (value: unknown) => {
    const dt = toDateTime(value);
    return dt ? (dt.toRelative() ?? '') : '';
  });
  hbs.registerHelper('datetimeLocal', (value: unknown) => {
    if (value === null || value === undefined || value === '') return '';
    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
    ) {
      return value.slice(0, 16);
    }
    if (
      !(value instanceof Date) &&
      typeof value !== 'string' &&
      typeof value !== 'number'
    ) {
      return '';
    }
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime())
      ? typeof value === 'string'
        ? value
        : String(value)
      : d.toISOString().slice(0, 16);
  });
  app.enableShutdownHooks();
  app.enableVersioning({ type: VersioningType.URI });
  // One hop: Traefik. Trusting all proxies would let clients spoof
  // X-Forwarded-For and bypass the throttler, which keys on req.ip.
  app.set('trust proxy', 1);

  // Validated + defaulted by config.schema.ts (PORT defaults to 3000 there).
  await app.listen(app.get(ConfigService).getOrThrow<number>('PORT'));
}

bootstrap().catch(async (err) => {
  Sentry.captureException(err, { tags: { phase: 'bootstrap' } });
  Logger.error(err, 'Bootstrap');
  await Sentry.flush(2000).catch((flushErr) => {
    Logger.error(flushErr, 'SentryFlush');
  });
  process.exit(1);
});
