# Postman collection

| File | What it is |
| --- | --- |
| `Event-Registration-API.postman_collection.json` | Every API endpoint, grouped in run order, with tests |
| `local.postman_environment.json` | Settings for a local API on `http://localhost:4000` |

## Import

1. In Postman, go to **Import** and drop in both files.
2. Pick **Event API – Local** in the environment dropdown (top right).
3. Start the API with `npm run dev`.

## Run it

Run the folders **in order**: `0. Health` → `9. Cleanup`. Click through them one by one, or use **Run collection** (Collection Runner) to run them all.

The test scripts save tokens and ids (`organizerToken`, `eventId`, `qrToken`, `paymentReference`, …) into collection variables, so every later request is authenticated and points at the right records. Each run creates new users and a new event, using a `runId` in their names and emails. To start completely fresh, clear the `runId` collection variable.

What the folders do:

| Folder | Covers |
| --- | --- |
| 0. Health | API and database are up |
| 1. Auth | Sign up an organizer and two attendees, log in, refresh, me, forgot/reset password, admin login |
| 2. Events & tickets | Create an event, add a free and a VIP ticket, publish, update, banner, search, get by slug |
| 3. Registration | Free ticket (confirmed with a QR code), paid ticket (pending + checkout URL), duplicate check (409), my tickets, download the QR as a PNG |
| 4. Payments (Paystack demo) | Resume checkout, demo checkout page, simulated payment, signed webhook (shows a duplicate is ignored), bad signature (401) |
| 5. Check-in | Scan the QR code, then scan it again (409 `TICKET_ALREADY_USED`) |
| 6. Reports | Stats with the money summary, attendee list, CSV, role check (403) |
| 7. Payouts | Set the organizer's bank account, list payouts |
| 8. Admin | Users, platform revenue, payouts, retry, change event status |
| 9. Cleanup | Cancel the paid ticket (refunded), log out, cancel the event |

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://localhost:4000/api/v1` | Change it for a deployed API |
| `password` | `password123` | Password for the users the collection creates |
| `paystackSecret` | `sk_demo_local_secret` | Must match the API's `PAYSTACK_SECRET_KEY`. If that's empty in demo mode, the API uses this default. |
| `adminEmail` / `adminPassword` | placeholders | There's no admin sign-up. Make a user admin in MongoDB (`users` → `role: "admin"`) and put its login here. Until then, folder 8 returns 401. |

## Notes

- **Real email:** if the API has a real `BREVO_API_KEY`, sign-ups and tickets send real emails. The collection uses `@example.com` addresses, which Brevo will reject or bounce. To receive the ticket email yourself, change the attendee email in **Register attendee** to an address you own.
- **Banner upload:** pick an image file for the `banner` field before sending. Without a file you get 400. Without Cloudinary keys you get 503.
- **Reset password:** this needs the token from the reset email. Paste it into the `resetToken` variable, otherwise expect 400.
- **Paid tickets:** to see the checkout page the way an attendee does, open the saved `checkoutUrl` in a browser.
