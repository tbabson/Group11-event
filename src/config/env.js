import dotenv from 'dotenv';
import { z } from 'zod';

const isTest = process.env.NODE_ENV === 'test';
// Tests must not pick up real keys (Brevo, Paystack) from a developer's .env.
if (!isTest) dotenv.config();

// An empty value (e.g. "APP_URL=" left in a dashboard) means "not set", not "invalid URL".
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

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
  // PAYSTACK_MOCK=true simulates Paystack (demo checkout page, no account needed);
  // PAYSTACK_MOCK=false uses the real Paystack API with PAYSTACK_SECRET_KEY (sk_test_… or sk_live_…).
  // PAYSTACK_MODE=demo|live is the older spelling and still works; it wins if both are set.
  PAYSTACK_MOCK: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  PAYSTACK_MODE: z.enum(['demo', 'live']).optional(),
  PAYSTACK_SECRET_KEY: z.string().default(''),
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  // Where Paystack (and the demo checkout) sends the buyer after paying.
  // Default: <first CLIENT_URL>/payments/callback (the frontend's callback page).
  PAYSTACK_CALLBACK_URL: optionalUrl,
  // Public base URL of this API, used for the demo checkout links. On Render it falls back
  // to RENDER_EXTERNAL_URL, which Render sets automatically.
  APP_URL: optionalUrl,
  RENDER_EXTERNAL_URL: optionalUrl,
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
  // Every banner is stored at exactly this size (16:9), cropped to fill.
  BANNER_WIDTH: z.coerce.number().int().positive().default(1080),
  BANNER_HEIGHT: z.coerce.number().int().positive().default(608),
  CLOUDINARY_URL: z.string().optional(),
  HOLD_MINUTES: z.coerce.number().int().positive().default(15),
  // Most tickets one person can buy in a single order (each ticket gets its own QR code).
  MAX_TICKETS_PER_ORDER: z.coerce.number().int().min(1).max(100).default(10),
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
// On Render, a localhost APP_URL (usually copied from a local .env) would send buyers'
// checkout links to their own machine, so Render's real public URL wins.
const isLocalhost = (url) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url || '');
if (env.RENDER_EXTERNAL_URL && isLocalhost(env.APP_URL)) {
  // eslint-disable-next-line no-console
  console.warn(`APP_URL=${env.APP_URL} ignored on Render; using ${env.RENDER_EXTERNAL_URL}. Remove APP_URL from Render's environment.`);
  env.APP_URL = undefined;
}
env.APP_URL = (env.APP_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT}`).replace(/\/$/, '');
env.PAYSTACK_MODE = env.PAYSTACK_MODE ?? (env.PAYSTACK_MOCK === false ? 'live' : 'demo');
env.PAYSTACK_CALLBACK_URL = env.PAYSTACK_CALLBACK_URL || `${env.CLIENT_ORIGINS[0]}/payments/callback`;
if (env.RENDER_EXTERNAL_URL) {
  for (const [name, value] of [['CLIENT_URL', env.CLIENT_ORIGINS[0]], ['PAYSTACK_CALLBACK_URL', env.PAYSTACK_CALLBACK_URL]]) {
    if (isLocalhost(value)) {
      // eslint-disable-next-line no-console
      console.warn(`${name}=${value} points to localhost on Render: buyers will be sent there after paying. Set it to your deployed frontend URL.`);
    }
  }
}

if (env.PAYSTACK_MODE === 'live' && !env.PAYSTACK_SECRET_KEY) {
  // eslint-disable-next-line no-console
  console.error('PAYSTACK_SECRET_KEY is required when PAYSTACK_MOCK=false (or PAYSTACK_MODE=live)');
  process.exit(1);
}
// In demo mode the "webhooks" are signed locally, so any stable secret works.
if (env.PAYSTACK_MODE === 'demo' && !env.PAYSTACK_SECRET_KEY) env.PAYSTACK_SECRET_KEY = 'sk_demo_local_secret';

export default env;
