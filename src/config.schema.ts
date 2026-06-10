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
  PORT: port.default(3000),

  // Queue configuration
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: port,

  // TTL (ms) for cached map reads (notice metrics, change-detection manifest).
  // Short by design: clients polling for changes tolerate this much staleness,
  // and it spares the DB the repeated COUNT/aggregate fan-out under load.
  MAP_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Model for the notice enrichment call (ENRICH_MODEL wins over the generic
  // OPENAI_MODEL; enrich.ts hardcodes the final fallback). Validated here so a
  // typo'd var name or empty value fails at boot instead of surfacing as
  // per-job enrichment failures.
  ENRICH_MODEL: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).optional(),

  // Vision cross-check of extracted geometry against the notice's own chart
  // pages (vision-verify.ts). Costs one image-bearing model call per geometry
  // notice; a mismatch flags the record for manual review, nothing more.
  // String enum rather than coerce.boolean: Boolean('false') is true.
  VISION_VERIFY: z.preprocess(
    (v) => (v === '' || v === undefined ? 'true' : v),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  ),
  // Model for the vision call (must be multimodal). Falls back to the
  // enrichment model chain when unset.
  VISION_MODEL: z.string().min(1).optional(),

  // Outbound proxy for the Transport Malta scrape (http.ts reads it at import
  // time). Optional — but validated so an empty value fails loudly rather than
  // silently disabling the proxy and getting the scraper 403'd.
  SCRAPER_PROXY_URL: z.string().min(1).optional(),

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
  // Deploy identifier (git SHA) shared by Sentry.init and the source-map
  // upload. Read directly from process.env in instrument.ts before this schema
  // runs, so it's validated here only for completeness / passthrough.
  SENTRY_RELEASE: z.string().optional(),
});

// Fed to ConfigModule.forRoot({ validate }). Coerces and defaults the known
// keys while passing the rest of the environment through untouched, then throws
// a ZodError (aborting boot) if anything required is missing or malformed.
export function validateConfig(
  env: Record<string, unknown>,
): Record<string, unknown> {
  return { ...env, ...configSchema.parse(env) };
}
