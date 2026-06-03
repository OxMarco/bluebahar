import { configValidationSchema } from './config.schema';
import type { ValidationError } from 'joi';

const validEnv = {
  DB_HOST: 'postgres',
  DB_PORT: 5432,
  DB_NAME: 'bluebahar',
  DB_USERNAME: 'bluebahar',
  DB_PASSWORD: 'secret',
  NODE_ENV: 'production',
  PORT: 3000,
  REDIS_HOST: 'redis',
  REDIS_PORT: 6379,
  OPENAI_API_KEY: 'sk-test',
  ADMIN_API_KEY: 'x'.repeat(32),
  ADMIN_JWT_SECRET: 'y'.repeat(32),
  ADMIN_SESSION_TTL_SECONDS: 3600,
  THROTTLE_TTL_MS: 60_000,
  THROTTLE_LIMIT: 120,
  NOTICE_SCRAPE_BATCH_SIZE: 10,
  SENTRY_DSN: 'https://public@example.com/1',
  SENTRY_TRACES_SAMPLE_RATE: 0.1,
  SENTRY_PROFILES_SAMPLE_RATE: 0.05,
};

function validate(env: Record<string, unknown>) {
  return configValidationSchema.validate(env, { abortEarly: false });
}

function errorPaths(error: ValidationError | undefined): string[] {
  return error?.details.map((detail) => detail.path.join('.')) ?? [];
}

describe('configValidationSchema', () => {
  it('accepts a complete production configuration', () => {
    const result = validate(validEnv);

    expect(result.error).toBeUndefined();
  });

  it('requires infrastructure and application secrets', () => {
    const incomplete: Record<string, unknown> = { ...validEnv };
    delete incomplete.DB_PASSWORD;
    delete incomplete.OPENAI_API_KEY;
    delete incomplete.ADMIN_API_KEY;

    const { error } = validate(incomplete);

    expect(errorPaths(error)).toEqual(
      expect.arrayContaining([
        'DB_PASSWORD',
        'OPENAI_API_KEY',
        'ADMIN_API_KEY',
      ]),
    );
  });

  it('rejects invalid ports, batch sizes, and sample rates', () => {
    const { error } = validate({
      ...validEnv,
      DB_PORT: 70_000,
      PORT: 70_001,
      THROTTLE_TTL_MS: 0,
      THROTTLE_LIMIT: 0,
      NOTICE_SCRAPE_BATCH_SIZE: 0,
      SENTRY_TRACES_SAMPLE_RATE: 1.5,
    });

    expect(errorPaths(error)).toEqual(
      expect.arrayContaining([
        'DB_PORT',
        'PORT',
        'THROTTLE_TTL_MS',
        'THROTTLE_LIMIT',
        'NOTICE_SCRAPE_BATCH_SIZE',
        'SENTRY_TRACES_SAMPLE_RATE',
      ]),
    );
  });
});
