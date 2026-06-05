import { z } from 'zod';

// Env vars arrive as strings (or as raw values in tests), so every numeric
// field coerces. Ports share one schema. Unknown keys are preserved by
// validateConfig so the rest of process.env stays visible to ConfigService.
const port = z.coerce.number().int().min(0).max(65535);

export const configSchema = z.object({
  // Database configuration
  DB_HOST: z.string().min(1),
  DB_PORT: port,
  DB_NAME: z.string().min(1),
  DB_USERNAME: z.string().min(1),
  DB_PASSWORD: z.string().min(1),

  // Application configuration
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: port,

  // Queue configuration
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: port,

  // TTL (ms) for cached map reads (notice metrics, change-detection manifest).
  // Short by design: clients polling for changes tolerate this much staleness,
  // and it spares the DB the repeated COUNT/aggregate fan-out under load.
  MAP_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Pre-shared admin secret. The user types this into the /admin/login form;
  // the controller constant-time compares it to mint a session JWT. Min length
  // keeps it from being trivially brute-forced.
  ADMIN_API_KEY: z.string().min(6).max(32),

  // Signs the admin-panel session cookie. Distinct from ADMIN_API_KEY so the
  // pre-shared key can be rotated without invalidating live browser sessions
  // (and vice versa).
  ADMIN_JWT_SECRET: z.string().min(6).max(32),

  // Admin session lifetime in seconds. Short by design — the panel re-prompts
  // for the pre-shared key rather than issuing refresh tokens.
  ADMIN_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60),

  // Public API throttling window and request limit
  THROTTLE_TTL_MS: z.coerce.number().int().positive().default(60_000),
  THROTTLE_LIMIT: z.coerce.number().int().positive().default(120),

  // Max number of notice-to-mariners PDFs to enqueue per cron iteration
  NOTICE_SCRAPE_BATCH_SIZE: z.coerce.number().int().positive(),

  // Sentry
  SENTRY_DSN: z.url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  SENTRY_PROFILES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

// Fed to ConfigModule.forRoot({ validate }). Coerces and defaults the known
// keys while passing the rest of the environment through untouched, then throws
// a ZodError (aborting boot) if anything required is missing or malformed.
export function validateConfig(
  env: Record<string, unknown>,
): Record<string, unknown> {
  return { ...env, ...configSchema.parse(env) };
}
