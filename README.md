# Event Registration & Management API

The backend for creating events, selling free and paid (Paystack) tickets, managing waitlists, and checking people in with QR codes. Built with Express and MongoDB (Mongoose).

- API base: `/api/v1`. Interactive docs are at **`/api/docs`** and the raw spec is at `/api/docs.json`.
- Roles: `admin`, `organizer` (creates and runs their own events), `attendee` (registers).
- Prices are integers in the currency's smallest unit (NGN kobo): `500000` = ₦5,000.
- The code is written as ES modules (`"type": "module"`), so use `import`/`export` and give relative imports a `.js` extension. Jest runs in ESM mode, which `npm test` turns on with `--experimental-vm-modules`. Test files import `jest` from `@jest/globals`.

## Quick start

```bash
cp .env.example .env          # then fill in secrets and MONGODB_URI
npm install
npm run dev                   # http://localhost:4000/api/docs
```

MongoDB **must be a replica set**, because registrations use transactions. The easiest option is a free MongoDB Atlas cluster, which is always a replica set. If you run MongoDB locally instead, start it as a single-node replica set:

```bash
mongod --replSet rs0 --dbpath <data-dir>
mongosh --eval "rs.initiate()"     # once
# MONGODB_URI=mongodb://localhost:27017/events?replicaSet=rs0
```

| Script | What it does |
| --- | --- |
| `npm run dev` / `npm start` | Run the API (dev mode reloads on file changes) |
| `npm test` | Jest + Supertest against an in-memory replica set (no setup needed) |
| `npm run test:coverage` | Same, with coverage. Fails if services drop below 70% |
| `npm run lint` | ESLint |

## Configuration

See [.env.example](.env.example) for every variable. The ones that need attention:

- `MONGODB_URI`: replica set connection string.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`: long random strings. Access tokens last 15 minutes; refresh tokens last 7 days and rotate on every use.
- `PAYSTACK_MODE`: **`demo` by default**, see [Paystack demo mode](#paystack-demo-mode). Set it to `live` together with `PAYSTACK_SECRET_KEY` to use real Paystack, then point Paystack's webhook URL to `https://<host>/api/v1/payments/webhook`.
- `APP_URL`: this API's public URL, used to build demo checkout links. Set it when deployed.
- **Email (Brevo):** set `BREVO_API_KEY` (Brevo → SMTP & API → API keys) and set `MAIL_FROM` to a sender verified in Brevo. If you'd rather use Brevo's SMTP relay, leave the API key empty and set `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`. If neither is set, emails are only logged.
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (Cloudinary dashboard → API Keys): enable banner uploads, which are stored under `CLOUDINARY_FOLDER` (default `event-banners`). `CLOUDINARY_URL` works instead of the three keys. With neither, the banner endpoint returns 503.
- `CLIENT_URL`: CORS allowlist (comma-separated). The first entry is used for links in emails.

## How registration works

1. `POST /events/:id/register { ticketTypeId }`. The event must be published, the ticket's sale window open, and the user not already registered (409 otherwise).
2. The seat is claimed with one atomic update, `sold < quantity → $inc sold`, inside a transaction with the registration insert, so two buyers can never take the last seat.
   - Sold out → `waitlisted`, **202**.
   - Free → `confirmed`, a QR token is created and the ticket email (QR image) is queued, **201**.
   - Paid → `pending` with a 15-minute hold. The response includes Paystack's `checkoutUrl`, **201**.
3. Paystack calls `POST /payments/webhook`. The HMAC-SHA512 signature is checked against the raw body, and handling is idempotent per payment reference.
   - `charge.success` → payment `success`, registration `confirmed`, QR code and ticket email.
   - `charge.failed` → payment `failed`, registration `cancelled`, seat released.
   - A payment that arrives after its hold expired gets the seat back if one is free. Otherwise it is refunded automatically.
4. Each time a seat is released (cancellation, failed payment, expired hold), the oldest waitlisted person is promoted. On a free ticket they're confirmed. On a paid ticket they get a new hold and an emailed checkout link.
5. `POST /events/:id/check-in { qrToken }` marks the ticket `checked-in` exactly once. Scanning it again returns **409 `TICKET_ALREADY_USED`**.

Cancelling a confirmed paid ticket refunds it when the event's `refundPolicy` is `full`, or when the organizer cancels it. Cancelling an event cancels and refunds every registration.

## Platform fee and organizer payouts

**Fee:** each paid ticket is split when checkout starts and recorded on the `Payment`. The split never changes after that.

```text
amount 500,000 kobo (₦5,000) → platformFee 25,000 (5%) + organizerNet 475,000
```

`PLATFORM_FEE_PERCENT` (default 5) and `PLATFORM_FEE_FLAT` (kobo, default 0) set the rate. The buyer pays the listed price and the fee comes out of the organizer's share. Free tickets pay no fee.

**Held funds:** the money stays in the platform's Paystack balance. A ledger in the database records how much belongs to each organizer. Their share is **held until `PAYOUT_HOLD_DAYS` (default 3) after the event ends**:

- Refunds and cancellations before then come out of the held amount, so the platform never has to recover money from an organizer.
- A cancelled event refunds every attendee, and its organizer is never paid.
- Once the hold ends, the hourly `releasePayouts` job creates one `Payout` per event (per currency), for the organizer net minus any refunds. Each payment is attached to its payout, so nothing is paid twice.
- The payout is sent to the organizer's account, which they set with `PUT /me/payout-account { bankCode, accountNumber, accountName }`.
  - **Demo mode:** the transfer is simulated and the payout is marked `paid` straight away.
  - **Live mode:** it's sent with Paystack Transfers and becomes `paid` or `failed` through the `transfer.*` webhooks.
- If the organizer has no payout account yet, the payout waits as `awaiting_account` and is sent as soon as they add one.
- An admin can retry a `failed` payout with `POST /admin/payouts/:id/retry`.

Payout status flow: `pending → processing → paid`, with `awaiting_account` and `failed` as side branches.

**Reports:**
- `GET /events/:id/stats` includes `finance` per currency: `gross`, `platformFee`, `organizerNet`, `refunded`, `held`, `availableAt`, `payout`.
- Organizers see their own payouts at `GET /me/payouts`.
- Admins get platform earnings at `GET /admin/revenue?from=&to=` and every payout at `GET /admin/payouts`.

This is not a licensed escrow account. Paystack holds the money as the payment processor. The platform only decides *when* each organizer's share is released.

## Paystack demo mode

Payments run in demo mode unless `PAYSTACK_MODE=live`. You don't need a Paystack account, and no real money moves.

1. Register for a paid ticket. The response's `checkoutUrl` is
   `{APP_URL}/api/v1/payments/demo/checkout/<reference>`.
2. Open that URL in a browser. It shows a demo checkout page with the event, ticket and amount, plus **Pay** and **Decline** buttons.
3. Each button builds the payload Paystack would send, signs it with HMAC-SHA512, and passes it through the **real webhook handler**. Everything downstream works exactly as it will in live mode: confirmation, QR ticket email, seat release, waitlist promotion and refunds (which are simulated in demo mode).

Without a browser (Postman, curl):

```bash
curl -X POST {APP_URL}/api/v1/payments/demo/checkout/<reference>/complete \
  -H "Content-Type: application/json" -d '{"outcome":"success"}'   # or "failed"
```

In live mode these routes return 404.

## Background jobs (node-cron, in-process)

| Job | Schedule | Action |
| --- | --- | --- |
| Expire holds | every minute | Cancel `pending` past `holdExpiresAt`, release the seat, promote the waitlist |
| Reminders | hourly | Email confirmed attendees of events starting within 24 hours (once each) |
| Close events | hourly | Published events past `endAt` → `completed` |
| Release payouts | hourly | Pay organizers for completed events once `PAYOUT_HOLD_DAYS` has passed |
| Email queue | every 10 s | Send queued emails, retrying 3 times with backoff |

The jobs and the email queue run inside the API process, so run **one instance**. To scale out, move them to BullMQ + Redis.

## Endpoints

| Area | Method and path | Access |
| --- | --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password` | Public |
| Me | `GET /me`, `GET /me/registrations` | Signed in |
| Events | `GET /events`, `GET /events/:slug` | Public (drafts only for the owner) |
| Events | `POST /events`, `PATCH /events/:id`, `DELETE /events/:id`, `POST /events/:id/publish`, `/unpublish`, `/banner` | Organizer (owner) / admin |
| Tickets | `POST /events/:id/tickets`, `PATCH /tickets/:id` | Organizer (owner) |
| Registration | `POST /events/:id/register`, `DELETE /registrations/:id` | Attendee (organizer may cancel on their event) |
| Ticket QR | `GET /registrations/:id/qr` (PNG download; `?inline=true` to display, `?size=150-1000`) | Attendee (own) / organizer / admin |
| Payments | `POST /payments/initialize`, `POST /payments/webhook` | Attendee / Paystack |
| Payments (demo) | `GET /payments/demo/checkout/:reference`, `POST …/:reference/complete` | Public, demo mode only |
| Check-in | `POST /events/:id/check-in` | Organizer (owner) |
| Reports | `GET /events/:id/attendees`, `/stats`, `/attendees.csv` | Organizer (owner) |
| Payouts | `PUT /me/payout-account`, `GET /me/payouts` | Organizer |
| Admin | `GET /admin/users`, `PATCH /admin/events/:id/status`, `GET /admin/payouts`, `POST /admin/payouts/:id/retry`, `GET /admin/revenue` | Admin |
| Ops | `GET /api/v1/health` | Public |

`GET /events` filters: `q` (text), `category`, `city`, `from`, `to`, `minPrice`, `maxPrice`, `isFree`, `page`, `limit` (max 50), `sort` (`startAt`, `-createdAt`, `title`). List responses include `meta: { page, limit, total }`.

Every error has the same shape:

```json
{ "success": false, "error": { "code": "TICKETS_SOLD_OUT", "message": "...", "details": [] } }
```

`400` validation (with `details` per field), `401` missing/expired token, `403` wrong role or not the owner, `404` not found, `409` conflict (already registered, ticket used, …), `429` rate limited, `502` payment provider error, `500` unexpected.

Sign-up only creates `attendee` or `organizer` accounts. To create the first admin, update a user's `role` in the database.

## Project layout

```text
src/
  config/       env (validated with Zod), db, logger (pino), OpenAPI spec
  routes/       all routes under /api/v1
  middleware/   auth + role guards, validation, rate limits, uploads, error handler
  controllers/  thin HTTP adapters
  services/     business rules: registration, waitlist, inventory, payment, check-in, reports, email (Brevo)
  models/       User, RefreshToken, Event, TicketType, Registration, Payment
  jobs/         cron jobs
  utils/        errors, pagination, CSV, transactions
tests/          unit + integration (mongodb-memory-server replica set)
```

## Security notes

helmet, CORS allowlist, rate limits on auth and registration, `express-mongo-sanitize`, strict Zod schemas (unknown fields are rejected), bcrypt (cost 12), hashed and rotated refresh tokens with reuse detection, hashed single-use password-reset tokens, constant-time webhook signature check, and CSV formula-injection escaping. Secrets come from the environment only.

## Deploying (Render / Railway)

Use `npm start` as the start command. Set the env vars above with a MongoDB Atlas URI, then point the Paystack webhook at the deployed URL. The app trusts one proxy hop so rate limiting sees real client IPs.
