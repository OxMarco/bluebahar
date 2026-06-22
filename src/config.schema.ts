import { z } from 'zod';

// Env vars arrive as strings (or as raw values in tests), so every numeric
// field coerces. Ports share one schema. Unknown keys are preserved by
// validateConfig so the rest of process.env stays visible to ConfigService.
const port = z.coerce.number().int().min(0).max(65535);
const optionalString = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.string().min(1).optional(),
);

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

  // Shared cache configuration
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: port,

  // TTL (ms) for cached map reads (notice metrics, change-detection manifest).
  // Short by design: clients polling for changes tolerate this much staleness,
  // and it spares the DB the repeated COUNT/aggregate fan-out under load.
  MAP_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),

  // OpenAI. Required: the community-map import generates every zone description
  // with the LLM, so there is no key-free path.
  OPENAI_API_KEY: z.string().min(1),

  // Model for community-map zone descriptions. ENRICH_MODEL wins over the
  // generic OPENAI_MODEL; the map importer has a final default.
  ENRICH_MODEL: optionalString,
  OPENAI_MODEL: optionalString,

  // Community "Malta Ranger Unit" My Map id. The daily import (CommunityMapImport
  // Service) pulls this map's marine layers as the authoritative source of zone
  // geometry + classification. Optional — the service hardcodes the known id as
  // the default; override to point a fork/staging run at a different map.
  COMMUNITY_MAP_MID: optionalString,
  // Toggle the community-map import. Defaults true. String enum rather than
  // coerce.boolean: Boolean('false') is true.
  COMMUNITY_MAP_IMPORT_ENABLED: z.preprocess(
    (v) => (v === '' || v === undefined ? 'true' : v),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  ),
  // Bathing-water classification import (EHD weekly "Site Classification Update
  // Report" PDF, merged onto the beaches layer by Site_Code). Defaults true. The
  // EHD site sits behind Cloudflare Bot Management; the importer fetches via
  // impit (browser-fingerprint impersonation), so plain-client 403s don't apply.
  // The source page and parse model are hardcoded; this is the only knob. String
  // enum (not coerce.boolean) for the same reason as COMMUNITY_MAP_IMPORT_ENABLED.
  BATHING_CLASSIFICATION_IMPORT_ENABLED: z.preprocess(
    (v) => (v === '' || v === undefined ? 'true' : v),
    z.enum(['true', 'false']).transform((v) => v === 'true'),
  ),

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
