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
  CACHE_TTL: 300000,
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
    const incomplete = { ...validEnv };
    delete incomplete.DB_PASSWORD;
    delete incomplete.OPENAI_API_KEY;

    const { error } = validate(incomplete);

    expect(errorPaths(error)).toEqual(
      expect.arrayContaining(['DB_PASSWORD', 'OPENAI_API_KEY']),
    );
  });

  it('rejects invalid ports, cache settings, batch sizes, and sample rates', () => {
    const { error } = validate({
      ...validEnv,
      DB_PORT: 70_000,
      PORT: 70_001,
      CACHE_TTL: -1,
      NOTICE_SCRAPE_BATCH_SIZE: 0,
      SENTRY_TRACES_SAMPLE_RATE: 1.5,
    });

    expect(errorPaths(error)).toEqual(
      expect.arrayContaining([
        'DB_PORT',
        'PORT',
        'CACHE_TTL',
        'NOTICE_SCRAPE_BATCH_SIZE',
        'SENTRY_TRACES_SAMPLE_RATE',
      ]),
    );
  });
});
