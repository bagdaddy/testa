import { z } from 'zod';

const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),

  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_USER: z.string().default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),
  CLICKHOUSE_DATABASE: z.string().default('default'),

  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_STREAM_KEY: z.string().default('events'),
  REDIS_CONSUMER_GROUP: z.string().default('collector-writers'),
  REDIS_CONSUMER_NAME: z.string().default(`collector-${process.pid}`),

  INGEST_SHARED_SECRET: z.string().min(16).default('dev-secret-change-me-please-1234'),
  /** Window (seconds) for HMAC replay protection. */
  INGEST_REPLAY_WINDOW: z.coerce.number().int().positive().default(300),

  SERVICE_TOKEN: z.string().min(16).default('dev-service-token-change-me-1234'),

  FX_API_URL: z.string().url().default('https://api.frankfurter.app'),

  CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().default(1000),
  CONSUMER_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

const parsed = envSchema.parse(process.env);

export const config = {
  environment: parsed.ENVIRONMENT,
  port: parsed.PORT,
  version: '0.0.0',

  clickhouse: {
    url: parsed.CLICKHOUSE_URL,
    user: parsed.CLICKHOUSE_USER,
    password: parsed.CLICKHOUSE_PASSWORD,
    database: parsed.CLICKHOUSE_DATABASE,
  },

  redis: {
    url: parsed.REDIS_URL,
    streamKey: parsed.REDIS_STREAM_KEY,
    consumerGroup: parsed.REDIS_CONSUMER_GROUP,
    consumerName: parsed.REDIS_CONSUMER_NAME,
  },

  ingest: {
    sharedSecret: parsed.INGEST_SHARED_SECRET,
    replayWindowSec: parsed.INGEST_REPLAY_WINDOW,
  },

  serviceToken: parsed.SERVICE_TOKEN,

  fxApiUrl: parsed.FX_API_URL,

  consumer: {
    batchSize: parsed.CONSUMER_BATCH_SIZE,
    flushIntervalMs: parsed.CONSUMER_FLUSH_INTERVAL_MS,
  },
} as const;
