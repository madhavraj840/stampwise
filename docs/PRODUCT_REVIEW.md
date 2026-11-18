# Product review: Druto vs Stampwise

Date: 2026-11-18

## 1. What the Druto code is

The zip (`index-BHaqRVxF.zip`) is **only the compiled frontend** of druto.in. It is a production Vite build, so the code is minified, and it has no backend. About 30 lazy-loaded pages are missing from the zip, including the customer Explore/Scan screens and the admin `Impersonate` page. So the customer side below is partly inferred from routes and API names.

| Layer | Druto | Stampwise |
|---|---|---|
| Frontend | React SPA (Vite, React Router, Redux Toolkit, Tailwind, Recharts, Framer Motion), installable PWA with service worker | Plain HTML + vanilla JS, no build step, ~600 lines total |
| Backend | Separate API at `api.druto.in/api`. `_id` fields suggest MongoDB, and one endpoint mentions Supabase | One Express file + Postgres (Neon) |
| Auth | Phone OTP for customers (`/users/send-otp`, `/users/verify-otp`); JWT **in localStorage** sent as a Bearer token | Phone-only login (OTP planned); httpOnly cookie sessions (safer than localStorage) |
| Live updates | Polling, plus Web Push to devices | Server-Sent Events (instant) plus 30 s polling fallback |
| Business model | ₹999/year, 3-day free trial, free QR stand; the QR is deactivated when the trial ends | Free (`plan` column already exists) |

## 2. Druto features (from routes, API calls and screen text)

**Business app**
- **Home:** scans today, completed cards, weekly scans chart, customer-growth chart, the QR, pending approvals with a sound alert (can be muted), and a trial/subscription banner.
- **Offers:** stamp cards (visits required, reward text, expiry in days, logo upload) and a **pause/resume program** switch.
- **Offers:** **scratch cards**, which are random prizes with winning odds ("X winners out of Y scans") and a prize expiry.
- **Rewards tab:** a claimed-rewards queue with Accept/Decline, covering scratch-card prizes as well.
- **Customers:** search, filters (Active / Completed / Rewards pending), sort, CSV download, and a per-customer view (stamp rewards earned and redeemed, scratch cards played and won, scan history, remove).
- **Multi-branch:** branches with an address and **GPS coordinates** (reverse geocoding through OpenStreetMap, plus a "Ready to Scan / Verified" badge, so scans are probably checked against location). There is one QR for every outlet and per-branch reports.
- **Digital menu:** AI import from a photo or PDF, Excel import, a manual editor (categories, items, photos, stock), styling, and a public live menu link on the same QR.
- **Profile:** category, description, opening hours, address, city and pincode.
- **Social links:** Instagram, Facebook, YouTube and WhatsApp, plus a **Google review link with randomized review suggestions** that customers can copy and paste.
- **Notifications:** per-type toggles (stamp requests, reward claims, scratch prizes), Web Push per device, and "pause all".
- **Help & Support:** a ticket form and a list of recent requests.
- **Connected apps:** API tokens for the Hisabe POS, scoped to view-only or view-and-approve, per location, with an expiry. Staff can approve from the POS.
- **Subscription:** payment, renewal, and "plan expired" lockout.
- **Roles:** `role`, `main-role` and `master_restaurant_id` (an owner versus branch staff).

**Customer app:** OTP login, Explore ("Discover Places. Earn Rewards."), scan through `/s/:id` and `/scan/:id`, rewards, profile, the shop's menu, and a scratch-and-win animation.

**Platform:** admin impersonation (`/impersonate`, "Admin view"). There is also a large marketing site: features, industry pages at `/for/:slug`, pricing, careers with résumé upload, contact, and legal pages.

## 3. Feature comparison

| Feature | Druto | Stampwise |
|---|---|---|
| Stamp card, approve/decline, auto-approve | ✅ | ✅ |
| Multiple rewards on one card (reward ladder) | one reward per program | ✅ **better** |
| One stamp per day rule | ? | ✅ |
| Customer has many shops in one wallet | ✅ (Explore) | ✅ |
| Join by typing a shop code | ? | ✅ |
| Redeem codes for rewards | accept/decline claims | ✅ 4-digit code |
| Customer import CSV/Excel with starting stamps | ❌ | ✅ **better** |
| WhatsApp message templates to customers | ❌ | ✅ **better** |
| Choice of stamp glyph | ❌ | ✅ |
| Live instant updates (no refresh) | push | ✅ SSE |
| OTP login | ✅ | ❌ (planned) |
| Scratch cards / random prizes | ✅ | ❌ |
| Pause program | ✅ | ❌ |
| Logo / images | ✅ | ❌ |
| Google review prompt + social links | ✅ | ❌ |
| Web Push notifications + installable PWA | ✅ | ❌ (desktop Notification only while the tab is open) |
| Multi-branch, GPS | ✅ | ❌ |
| Staff roles | ✅ | ❌ |
| Digital menu (AI) | ✅ | ❌ |
| POS integration / API tokens | ✅ | ❌ |
| Subscription & trial | ✅ | ❌ (`plan` column ready) |
| Support tickets | ✅ | ❌ (WhatsApp) |
| Admin panel / impersonation | ✅ | ❌ (see `ADMIN_PANEL.md`) |
| Self-service password reset | ? | manual via WhatsApp + SQL |

**Where Stampwise is already ahead:** simplicity and speed (no build, tiny pages that load fast on cheap phones), the reward ladder, bulk import, WhatsApp templates, live updates, and cookie sessions.

## 4. Features worth adding (in priority order)

| # | Feature | Why | Effort |
|---|---|---|---|
| 1 | **OTP login** | Today anyone who types your number sees your reward codes. Rewards cannot have real value until this exists. The hook is ready (README "Adding OTP later"). | M |
| 2 | **Admin panel** | Run the platform without SQL, deal with abuse, and approve password resets. | M–L |
| 3 | **Anti-fraud stamping** | A rotating QR on the shop's screen (a token valid for 2–5 min), or a staff PIN, or a geofence. Stops remote stamp farming (see the security review). | M |
| 4 | **Google review link + review suggestions** shown after a stamp | Direct growth for the shop, and a key Druto selling point. | S |
| 5 | **Pause program** switch | Shops on holiday or changing rewards. | S |
| 6 | **Shop logo upload** (safe pipeline, see the security review) | Cards look branded. | S–M |
| 7 | **PWA:** manifest, service worker, Web Push | Shops get alerts with the tab closed, customers get "reward ready" and "reward expiring" messages, and the app installs on the home screen. | M |
| 8 | **Plans & billing** (Razorpay subscriptions, trial) | Revenue. The `plan` column exists. Gate limits by plan (customers, imports, branches). | M |
| 9 | **Staff accounts** (approve-only role) | Owners stop sharing the password. Approvals record who approved. | M |
| 10 | **Scratch card / surprise reward** | Engagement. A random prize with odds on N% of stamps. | M |
| 11 | Shop: change password, verify email, "log out all devices" | Basic account hygiene. | S |
| 12 | Customer: delete account / download my data, privacy notice | Required under the India DPDP Act 2023. | S |
| 13 | Spend-based ("weighted") stamps, birthday reward, win-back automation | Retention features. Automation needs the WhatsApp Business API. | M |
| 14 | Multi-branch | Chains. A bigger schema change, so do it after staff roles. | L |
| 15 | Digital menu, POS tokens | Druto's differentiators. Only build them if customers ask. | L |

### Business-logic bugs found (not security)
- A reward is created only when stamps become **exactly** `stamps_required`. Customers imported with a starting balance at or past a reward step never get that reward. *(This is intended according to the README, but shops may not expect it.)*
- If a shop lowers `card_size` below a customer's current stamps, that customer's next stamp resets the card without the rewards in between being triggered.
- Removing a customer deletes their redeemed-reward history too, so the shop loses its record of what was given away.
- The shop dashboard loads at most 1000 customers and 300 claims. Anything beyond that is silently invisible, and search does not find it.

## 5. UI changes worth making (suggestions only, nothing changed)

**Customer app**
1. **Login:** turn step 2 ("Is this your number?") into the OTP entry screen when OTP arrives. Add links to Terms and Privacy and a one-line consent.
2. **Home cards:** show the shop logo once uploads exist. Show an "Expiring soon" badge on rewards within 3 days of expiry.
3. **Card screen:** add Google-review, Instagram and WhatsApp buttons to Shop info. After an approved stamp, show a "Enjoyed it? Leave a review" prompt.
4. **QR scanning on iPhone:** `BarcodeDetector` only works in Chrome/Android. Add a fallback library (e.g. jsQR) so iOS users can scan in the app.
5. **Rewards:** show the redeem code as a big QR as well, so staff can scan it later.
6. **Profile:** add Delete my account, Download my data, Privacy policy, and a Hindi/regional language toggle.
7. **Accessibility:** give the toast `role="status"`/`aria-live` so screen readers announce it.
8. **Install prompt:** add a small "Add to home screen" banner (PWA).

**Shop dashboard**
1. **Customers:** server-side search and pagination instead of loading up to 1000 rows. A shop with more than 1000 customers cannot see the rest today.
2. **Settings:** split it into *QR*, *Shop profile* and *Account* (change password, email, log out all devices).
3. **Approvals:** add "Approve all" and a short **Undo** after Decline.
4. **Overview:** add a date-range picker, a redemption-rate stat, and the top customers.
5. **Onboarding checklist** for new shops: add a reward, then print the QR, then get the first scan.
6. Replace native `confirm()` dialogs with the existing sheet component, for a consistent look.
7. Ask for notification permission at the first approval, not only from a button buried in Settings.
8. **Plan/trial banner** once billing exists.
