import dotenv from 'dotenv';
import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';
// Tests must not pick up real keys (Brevo, Paystack) from a developer's .env.
if (!isTest) dotenv.config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4001),
  MONGODB_URI: isTest ? z.string().optional() : z.string().min(1),
  // Optional comma-separated DNS servers for Node (fixes "querySrv ETIMEOUT" with mongodb+srv URIs).
  DNS_SERVERS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CLIENT_URL: z.string().default('http://localhost:5002'),
  // 'demo' simulates Paystack locally (no account or network needed); 'live' calls the real API.
  PAYSTACK_MODE: z.enum(['demo', 'live']).default('demo'),
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  // Public base URL of this API, used for the demo checkout links.
  APP_URL: z.string().url().optional(),
  BREVO_API_KEY: z.string().optional(),
  BREVO_BASE_URL: z.string().url().default('https://api.brevo.com/v3'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('Events <no-reply@events.local>'),
  // Cloudinary credentials (Dashboard → API Keys). CLOUDINARY_URL is accepted as an alternative.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('event-banners'),
  CLOUDINARY_URL: z.string().optional(),
  HOLD_MINUTES: z.coerce.number().int().positive().default(15),
  // Platform commission on each paid ticket, deducted from the organizer's share.
  PLATFORM_FEE_PERCENT: z.coerce.number().min(0).max(100).default(5),
  PLATFORM_FEE_FLAT: z.coerce.number().int().min(0).default(0), // smallest currency unit (kobo)
  // Organizer earnings are held until this many days after the event ends, then paid out.
  PAYOUT_HOLD_DAYS: z.coerce.number().min(0).default(3),
  LOG_LEVEL: z.string().default(isTest ? 'silent' : 'info'),
});

const defaults = isTest
  ? {
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789',
      PAYSTACK_SECRET_KEY: 'sk_test_dummy',
    }
  : {};

const parsed = schema.safeParse({ ...defaults, ...process.env });
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;
env.CLIENT_ORIGINS = env.CLIENT_URL.split(',').map((s) => s.trim()).filter(Boolean);
env.APP_URL = (env.APP_URL || `http://localhost:${env.PORT}`).replace(/\/$/, '');

if (env.PAYSTACK_MODE === 'live' && !env.PAYSTACK_SECRET_KEY) {
  // eslint-disable-next-line no-console
  console.error('PAYSTACK_SECRET_KEY is required when PAYSTACK_MODE=live');
  process.exit(1);
}
// In demo mode the "webhooks" are signed locally, so any stable secret works.
if (env.PAYSTACK_MODE === 'demo' && !env.PAYSTACK_SECRET_KEY) env.PAYSTACK_SECRET_KEY = 'sk_demo_local_secret';

export default env;
