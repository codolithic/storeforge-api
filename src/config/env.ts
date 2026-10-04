import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('./data/dev.db'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  // Serves /api/docs; unset means on everywhere except production.
  ENABLE_API_DOCS: z.stringbool().optional(),
});

// Fails fast at boot if required env vars are missing/invalid, instead of
// surfacing confusing errors deep inside a request handler later.
export const env = envSchema.parse(process.env);
