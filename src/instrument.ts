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
    // Ties every event to a deploy so Sentry can flag regressions and match
    // uploaded source maps to the running build. CI sets this to the git SHA
    // (the same value passed to `sentry-cli sourcemaps upload --release`);
    // undefined in dev, which is fine. MUST agree with the upload release or
    // stack frames stay minified.
    release: process.env.SENTRY_RELEASE,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.1),
  });
}
