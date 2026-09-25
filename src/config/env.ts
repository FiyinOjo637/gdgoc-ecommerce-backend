import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  PAYSTACK_SECRET_KEY: z.string().min(1),
  PAYSTACK_BASE_URL: z.string().default('https://api.paystack.co'),
  FRONTEND_CALLBACK_URL: z.string().default('http://localhost:3000/checkout/callback'),
  RESERVATION_TTL_MINUTES: z.coerce.number().default(15),
  RECONCILIATION_POLL_INTERVAL_MS: z.coerce.number().default(60000),
  ADMIN_SEED_EMAIL: z.string().default('admin@gdgoc.dev'),
  ADMIN_SEED_PASSWORD: z.string().default('Admin123!'),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loudly rather than booting a half-configured server.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isTest = env.NODE_ENV === 'test';
export const isProd = env.NODE_ENV === 'production';
