// Must execute before any other module so Sentry can patch globals before
// NestJS / OpenTelemetry-instrumented packages load. Keep this file at the top
// of main.ts via `import './instrument';`. TS compiles to CommonJS so the
// imports below become require() calls hoisted above any other module load.
import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

// No-op when DSN is absent so dev / test environments don't need Sentry config.
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.1),
  });
}
