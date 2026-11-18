# Stampwise – digital stamp-card loyalty

Node + Express + Postgres, no build step. Customers use `/`, shops use `/shop`. The admin panel is a separate app in `admin/`.
Built to run free on **Vercel Hobby + Neon Free** (it also runs on any Node host via `server.js` or the `Dockerfile`).

| Site | What | Vercel project root |
|---|---|---|
| `loyalty.bunkwise.in` | Customer app + shop dashboard | repo root |
| `admin.bunkwise.in` | Admin panel (can manage more projects later) | `admin` |

## Deploy (Vercel + Neon)
1. **Neon:** create a project in a Singapore region (closest free region to India). Settings → Compute: max **0.25 CU**, scale-to-zero **on (5 min)**. Copy the **pooled** connection string (host contains `-pooler`) and the direct one.
2. **Vercel project 1 (`stampwise`):** import the GitHub repo, root directory = repo root, region = Singapore (`sin1`, Settings → Functions). The build command (`node migrate.js`) and everything else come from `vercel.json`. Env vars:
   - `DATABASE_URL` = pooled string; `DATABASE_URL_UNPOOLED` = direct string (migrations only)
   - `BASE_URL=https://loyalty.bunkwise.in`, `NODE_ENV=production`, `TRUST_PROXY=1`, `DB_POOL_MAX=4`
   - `SESSION_SECRET`, `CRON_SECRET`: each `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SUPPORT_WHATSAPP` (digits, with 91)
   - optional shop push alerts: `npx web-push generate-vapid-keys` → `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:you@…`
3. **Vercel project 2 (`bunkwise-admin`):** import the same repo again, root directory = **`admin`**, region `sin1`. Env vars: `STAMPWISE_DATABASE_URL` (pooled), `STAMPWISE_DATABASE_URL_UNPOOLED` (direct), `ADMIN_SECRET` (32+ random chars, keep it safe: it encrypts 2FA secrets), `NODE_ENV=production`.
4. **DNS** (where bunkwise.in is managed): `CNAME loyalty → cname.vercel-dns.com` and `CNAME admin → cname.vercel-dns.com`. Add each domain in its Vercel project (Settings → Domains).
5. **First admin** (from your computer, in `admin/`): `npm install`, create `admin/.env` with `STAMPWISE_DATABASE_URL` and the same `ADMIN_SECRET`, then `node scripts/create-admin.js you@example.com owner`. It prints a password and a 2FA secret: add the secret to Google Authenticator, then log in at admin.bunkwise.in and change the password (My account). Running the script again for the same email resets its password and 2FA (lost phone).

Vercel Hobby is for non-commercial use. Move to Pro (or any Node host) before charging shops.

## How it stays inside the free limits
- **No open connections or timers:** no live streams, no keep-warm pings, so Neon sleeps when nobody is using it.
- **Sessions are signed cookies** (no session table lookups). Accounts are re-checked once an hour, so "log out all devices", suspend and block apply within an hour.
- **Shop dashboard keeps its own copy** of customers and rewards (in the browser) and downloads only rows changed since the last sync. Search, filters, sort, CSV and top customers run in the browser. Charts read a one-row-per-day table (`shop_days`).
- **New-request alerts:** web push when VAPID keys are set, otherwise a small sync every 60 s, only while the tab is visible and someone used it in the last 10 minutes. A paused shop stops syncing.
- **Customers** see their last home screen instantly from the phone, and only poll (every 5 s, max 2 minutes, only while the screen is open) while a stamp request is waiting.
- QR codes are drawn and read in the browser; logos are shrunk to 256 px in the browser; public shop info and logos are CDN-cached.
- A daily cron (`/api/cron/daily`) cleans rate limits, expires old reset requests and deletes declined requests older than 180 days.

## Anti-fraud (cheap, built in)
One waiting request per customer per shop · one stamp per day (unless the shop allows more) · max 2 requests per hour per shop and 20 per day overall · 10-minute cooldown after a decline · blocked customers and suspended shops refused · auto-approve needs a confirmation, and the admin dashboard flags auto-approve shops with very busy days and customers joining 5+ shops in a day. Rewards are redeemed with a 4-digit code or by scanning the customer's reward QR.

## Admin panel (`admin/`)
- Roles: **viewer** (read only), **support** (suspend/reactivate shops, block customers, approve resets), **owner** (also plan changes, erasing customers, admin users). An admin can be limited to some projects.
- Login: password + authenticator code (mandatory, a code works once). 5 wrong tries lock the account for 15 minutes. 12-hour sessions, `SameSite=Strict`, no indexing.
- Every action needs a reason and is written to an append-only audit log (a database trigger blocks edits and deletes).
- Screens: dashboard (totals, 30-day charts, top shops, flags), shops (read-only "view as shop"), customers (phones masked in lists, detail views are audited), password resets (one-click approve/reject), system (DB size, tables, migrations), audit log, admin users.
- **Adding another project:** copy `admin/adapters/stampwise.js`, describe its lists/actions/stats, add one line to `admin/projects.js` and set its `<NAME>_DATABASE_URL` env var. Admin tables live in schema `admin` of the first project's database (or `ADMIN_DATABASE_URL`).

## Run locally
`npm install`, copy `.env.example` to `.env` (set `DATABASE_URL`, remove `NODE_ENV`/`BASE_URL`), `npm run migrate`, `npm start`, open `http://localhost:3000/shop`. Admin: `cd admin && npm install && node migrate.js && node app.js` (port 4000).

## Database changes (migrations)
Numbered files in `migrations/` run once each, in order, in a transaction (`npm run migrate`, and on every Vercel build). Never edit a file that has run; add a new one. The admin app has its own `admin/migrations/` (tracked in `admin.schema_migrations`).

## Moving providers
Everything host-specific is an env var. Any Postgres works. Move the DB: `pg_dump --no-owner --no-acl "$OLD" > dump.sql; psql "$NEW" < dump.sql`, change the URLs. Move the app: the `Dockerfile` runs anywhere (keep `BASE_URL` so printed QR codes keep working).

## Shop password resets
After two wrong passwords the shop login offers **Reset via WhatsApp**: the shop picks a new password (stored hashed, pending) and WhatsApp opens with a request code. Check the message comes from the shop's registered phone, then approve it in **admin → Password resets**. Requests expire after 2 days.

## Adding OTP later
`verifyPhone(phone, body)` in `app.js` is the single hook every customer login goes through; `customers.phone_verified` already exists.

## Staff accounts (structure only)
`shop_staff` (approve-only role) and `stamp_requests.decided_by` exist; no screens yet.

## Known limits
- Without OTP, anyone who knows a phone number can open that customer's card.
- Session revocation (log out all, suspend, block) takes up to an hour; admin changes to admin users are immediate.
- In-memory rate limits are per serverless instance; login/signup/reset limits are shared through the database.
- Renaming: `public/brand.js`, the `<title>` tags, `package.json`.
