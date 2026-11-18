# Stampwise v2 – digital stamp-card loyalty (free, no OTP yet)

Node + Express + Neon Postgres, no build step. Customers use `/`, shops use `/shop`.

## Renaming the product
The name is set in `public/brand.js` (used in headers and tab titles). Also change the two `<title>` tags in `public/customer.html` and `public/shop.html`, and `name` in `package.json`.

## Upgrading from v1
1. Replace the old files with these (keep your `.env`).
2. Run `npm install`, then `npm run migrate`. It is safe to re-run: it adds shop codes, redeem codes and indexes without touching existing data.
3. `npm start`

## Run from scratch
1. `npm install`
2. Copy `.env.example` to `.env`, paste your Neon string into `DATABASE_URL` (remove `NODE_ENV` and `BASE_URL` for local testing)
3. `npm run migrate`, then `npm start`, then open `http://localhost:3000/shop`

## Database changes (migrations)
Schema changes live in `migrations/` as numbered files (`001_init.sql`, `002_...`). `npm run migrate` runs each file once, in order, inside a transaction, and records it in the `schema_migrations` table. To change the schema, **add a new numbered file**; never edit one that has already run. Existing databases are safe: `001_init.sql` is the old `schema.sql` and only adds what is missing.

## Hosting and moving providers
- Everything host-specific is an environment variable (see `.env.example`). The app is plain Node + standard Postgres SQL, so any Postgres works (Neon, Supabase, RDS, Cloud SQL, self-hosted).
- **Move the database:** `pg_dump --no-owner --no-acl "$OLD_URL" > dump.sql`, `psql "$NEW_URL" < dump.sql`, change `DATABASE_URL`, run `npm run migrate`. Set `KEEP_DB_WARM=0` if the new database is not Neon.
- **Move the app:** `Dockerfile` runs on any container host and migrates on start. Set `TRUST_PROXY` to the number of proxies in front of the app, and `BASE_URL` (QR codes use it, so keep the domain when you move and old printed QRs keep working).

## Scaling (when one server is not enough)
One app instance handles a lot. Before running **two or more instances**, move these three in-memory pieces to a shared store (Redis is the usual choice): rate limits (`limit()`), live updates (`push()`/`events()`), and the 5-minute session cache (`sc`). Neon's pooled URL does not support Postgres `LISTEN/NOTIFY`, so Redis pub/sub is the simpler path for live updates.

## Adding OTP later
`verifyPhone(phone, body)` in `server.js` is the single hook every customer login goes through, and `customers.phone_verified` is already in the schema. Add an endpoint that sends the code (store only a hash, 5-minute expiry, max 5 attempts, rate-limited per phone and per IP), make `verifyPhone` check `body.code`, and set `phone_verified=true` on success.

## Resetting a shop's password (owner steps)
Set `SUPPORT_WHATSAPP` in `.env` to the WhatsApp number that should receive requests (country code + number, digits only).

After a shop gets its password wrong twice, the login page offers **Reset password via WhatsApp**. The shop chooses a NEW password, which is stored (hashed) in `password_resets` as a pending request, and WhatsApp opens with a message to you. Nothing changes until you approve it.

1. Check the WhatsApp message really comes from the shop's registered phone (`shop_phone` below). If the shop has no phone on file, verify another way (call them, or ask for something only the owner knows).
2. In the Neon SQL Editor, list pending requests (the message shows the request code, which matches `ref`):
```sql
select id, ref, shop_name, email, shop_phone, requested_at from password_resets where status = 'pending' order by id desc;
```
3. Approve one (replace `12` with its id). This copies the stored hashed password to the shop, signs out its old sessions, and marks the request done:
```sql
with r as (select shop_id, new_pass_hash from password_resets where id = 12 and status = 'pending'),
a as (update shops set pass_hash = (select new_pass_hash from r) where id = (select shop_id from r) returning id),
b as (delete from sessions where role = 'shop' and subject_id = (select shop_id from r)),
c as (update password_resets set status = 'done', resolved_at = now() where id = 12 and status = 'pending')
select count(*) as shops_updated from a;
```
`shops_updated = 1` means it worked and the shop can log in with the password it chose. To reject a suspicious request instead: `update password_resets set status = 'rejected', resolved_at = now() where id = 12;`

## Latest changes
- Shop password reset by WhatsApp request (see above), plus links between the customer and shop login pages. Run `npm run migrate` to add the `password_resets` table. Old pending requests are no longer cancelled by a newer one (that let anyone cancel a real request); they expire after 2 days.
- The customer's PHONE NUMBER is their account (unique, validated as a 10-digit mobile). The name is only a label: returning customers can log in with just their number, or type a new name to change it, or edit it in Profile. New numbers must give a name. Run `npm run migrate` once to add the phone-format check.
- Fixed: the shop password fields did not accept typing. Signup now has a confirm-password field and a Show password toggle.
- Sign-in lasts a year after your LAST visit, for customers and shops (it renews itself while you keep using it).
- Shops can add one customer, or import a CSV/Excel list (columns: Name, Phone, optional Stamps). Cards are created automatically. Imported stamps are a starting balance and do not trigger rewards.
- Excel files are read in the shop owner's browser using the SheetJS library from cdnjs (loaded only when needed); CSV works offline.

## What's new in v2
- Customers stay signed in for a year. Scanning a shop link again goes straight to Home.
- One customer, many shops. Add a shop by scanning its QR with the in-app camera (Chrome/Android) or typing its 6-letter shop code. Each card has a **Request stamp** button.
- Tap any reward for details and its 4-digit redeem code; the shop sees the code under **Winners**.
- Shop alerts on every tab: floating bar with Approve/Decline, red count on the Approvals tab, tab-title count, beep, optional desktop notifications. Updates are pushed live (no waiting for polling).
- Customers tab: search, filters, date range, sort, CSV export, expandable details, remove customer, **WhatsApp click-to-chat** (opens your own WhatsApp with the message ready).
- Overview: stats, weekly stamps chart, customer growth chart. Rewards can be edited.
- Shop address, hours and phone are shown to customers (with Call and Directions buttons).
- Swiss grid + editorial serif design.

## Why tabs are now fast
- The dashboard loads everything in ONE request (queries run in parallel) and renders tabs from memory instantly, refreshing quietly in the background.
- Sessions are cached in memory, and a ping every 4 minutes keeps Neon from sleeping.
- **Put your server in the same region as your Neon database** (for India, pick a Singapore/Mumbai-nearby region for both). Distance to the database is the biggest remaining factor.

## Deploy to loyalty.bunkwise.in
Neon is only the database. Run this Node app on a host (Render, Railway, Fly, or a VPS) in the same region as Neon. Set `DATABASE_URL`, `BASE_URL=https://loyalty.bunkwise.in`, `NODE_ENV=production`, then add a CNAME record for `loyalty` pointing to the host. Live updates need a host that allows long-lived connections (all of these do).

## Ready for OTP and more
- `verifyPhone()` in `server.js` is the single OTP hook; `customers.phone_verified` already exists.
- `shops.plan` is ready for paid tiers.

## Known limits
- Without OTP, anyone who knows a phone number can open that customer's card.
- Rate limiting and live-update connections are in memory, so run a single server instance for now.
- Camera QR scanning needs a browser with BarcodeDetector (Chrome on Android). Other browsers use the shop code or the phone's camera app.

## Design update (round 7)
- New look: flat surfaces, fog-grey page, navy, bottle green and stamp-ink blue. No gradients, no emojis, no logo mark.
- Icons are bundled SVGs (public/icons.js): Tabler Icons for the interface and Phosphor Icons for stamp marks, both MIT (see public/icons/LICENSES.txt). To add or swap an icon, edit the maps in icons.js.
- The card view shows a paper-style card with numbered printed circles; each approved stamp is a rubber-stamp impression (ring + shop glyph, slight random rotation, ink texture through the `#ink` SVG filter in common.js).
- Shops choose their stamp design in Settings (12 glyphs). Run `npm run migrate` once to add the `stamp_icon` column.
- Inner screens have a labelled Back button in the top bar, outside the card.
- To use your own stamp artwork later: replace the markup in `stampImg()` in common.js with an `<img>` of your PNG/SVG.
