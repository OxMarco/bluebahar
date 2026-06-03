import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // Database configuration
  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().required(),
  DB_NAME: Joi.string().required(),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),

  // Application configuration
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().required(),

  // Queue configuration
  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().required(),

  // OpenAI
  OPENAI_API_KEY: Joi.string().required(),

  // Pre-shared admin secret. The user types this into the /admin/login form;
  // the controller constant-time compares it to mint a session JWT. Min length
  // keeps it from being trivially brute-forced.
  ADMIN_API_KEY: Joi.string().min(6).max(32).required(),

  // Signs the admin-panel session cookie. Distinct from ADMIN_API_KEY so the
  // pre-shared key can be rotated without invalidating live browser sessions
  // (and vice versa).
  ADMIN_JWT_SECRET: Joi.string().min(6).max(32).required(),

  // Admin session lifetime in seconds. Short by design — the panel re-prompts
  // for the pre-shared key rather than issuing refresh tokens.
  ADMIN_SESSION_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(60 * 60),

  // Public API throttling window and request limit
  THROTTLE_TTL_MS: Joi.number().integer().positive().default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().positive().default(120),

  // Max number of notice-to-mariners PDFs to enqueue per cron iteration
  NOTICE_SCRAPE_BATCH_SIZE: Joi.number().integer().positive().required(),

  // Sentry
  SENTRY_DSN: Joi.string().uri().optional(),
  SENTRY_TRACES_SAMPLE_RATE: Joi.number().min(0).max(1).optional(),
  SENTRY_PROFILES_SAMPLE_RATE: Joi.number().min(0).max(1).optional(),
});
