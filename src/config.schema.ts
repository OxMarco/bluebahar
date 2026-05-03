import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // Database configuration
  DB_HOST: Joi.string().hostname().required(),
  DB_PORT: Joi.number().port().required(),
  DB_NAME: Joi.string().required(),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),

  // Application configuration
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
  PORT: Joi.number().port().required(),

  // Queue configuration
  REDIS_HOST: Joi.string().hostname().required(),
  REDIS_PORT: Joi.number().port().required(),

  // OpenAI
  OPENAI_API_KEY: Joi.string().required(),

  // Cache expiration time in milliseconds
  CACHE_TTL: Joi.number().positive().required(),

  // Filesystem directory where WFS dataset GeoJSON files are written
  DATASETS_STORAGE_DIR: Joi.string().required(),

  // Max number of notice-to-mariners PDFs to enqueue per cron iteration
  NOTICE_SCRAPE_BATCH_SIZE: Joi.number().integer().positive().required(),
});
