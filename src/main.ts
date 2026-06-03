import './instrument';
import { NestFactory, Reflector } from '@nestjs/core';
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
import cookieParser from 'cookie-parser';
import hbs from 'hbs';
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
        'script-src': ["'self'", 'https://unpkg.com'],
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
  hbs.registerHelper('formatDate', (value: unknown) => {
    if (value === null || value === undefined || value === '') return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
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

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  Logger.error(err, 'Bootstrap');
  process.exit(1);
});
