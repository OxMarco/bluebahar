import { configSchema } from './config.schema';

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
  SENTRY_DSN: 'https://public@example.com/1',
  SENTRY_TRACES_SAMPLE_RATE: 0.1,
  SENTRY_PROFILES_SAMPLE_RATE: 0.05,
};

function errorPaths(env: Record<string, unknown>): string[] {
  const result = configSchema.safeParse(env);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('configSchema', () => {
  it('accepts a complete production configuration', () => {
    expect(configSchema.safeParse(validEnv).success).toBe(true);
  });

  it('treats blank optional map and model values as unset', () => {
    const result = configSchema.safeParse({
      ...validEnv,
      OPENAI_MODEL: '',
      ENRICH_MODEL: '',
      COMMUNITY_MAP_MID: '',
    });
    expect(result.success).toBe(true);
  });

  it('requires infrastructure and application secrets', () => {
    const incomplete: Record<string, unknown> = { ...validEnv };
    delete incomplete.DB_PASSWORD;
    delete incomplete.ADMIN_API_KEY;

    expect(errorPaths(incomplete)).toEqual(
      expect.arrayContaining(['DB_PASSWORD', 'ADMIN_API_KEY']),
    );
  });

  it('requires the OpenAI key — descriptions are always AI-generated', () => {
    expect(errorPaths({ ...validEnv, OPENAI_API_KEY: '' })).toContain(
      'OPENAI_API_KEY',
    );
    const withoutKey: Record<string, unknown> = { ...validEnv };
    delete withoutKey.OPENAI_API_KEY;
    expect(errorPaths(withoutKey)).toContain('OPENAI_API_KEY');
  });

  it('rejects invalid ports, throttling values, and sample rates', () => {
    expect(
      errorPaths({
        ...validEnv,
        DB_PORT: 70_000,
        PORT: 70_001,
        THROTTLE_TTL_MS: 0,
        THROTTLE_LIMIT: 0,
        SENTRY_TRACES_SAMPLE_RATE: 1.5,
      }),
    ).toEqual(
      expect.arrayContaining([
        'DB_PORT',
        'PORT',
        'THROTTLE_TTL_MS',
        'THROTTLE_LIMIT',
        'SENTRY_TRACES_SAMPLE_RATE',
      ]),
    );
  });
});
