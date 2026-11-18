# Admin panel: features and design

Status: **proposal, waiting for approval**. Nothing is built yet. Pick the scope (MVP or MVP + phase 2) and it gets built.

## 1. Features

### MVP (build first)
| Area | What you can see | What you can do |
|---|---|---|
| **Dashboard** | Total shops, customers and cards. Active shops (stamp in the last 7 and 30 days). Stamps today / 7 days / 30 days. Rewards earned vs redeemed. Charts of new shops and new customers per day. Top 10 shops by activity. | – |
| **Shops** | A searchable list (name, email, phone, code) with filters for plan, status, created date and last activity. The shop page shows its profile, settings (auto-approve, multi-per-day, card size), rewards, customer count, stamps and redemptions over time, the last 50 requests, open sessions, and reset history. | **Suspend / reactivate** (its QR and logins stop working) · edit details · change plan / extend trial · **force logout** · **view as shop** (read-only) · soft delete |
| **Customers** | Search by phone or name. The customer page shows every card across shops, their rewards (codes, status, expiry), stamp requests, signup date and last seen. | Edit name · **block / unblock** · force logout · **delete (DPDP erasure)** · mark phone verified |
| **Password resets** | A queue of pending requests: shop name, email, registered phone, ref code, time, and how many requests that shop made recently. | **Approve / reject** with one click. This replaces the SQL steps in the README. |
| **Activity feed** | Every stamp request, approval, decline, reward earned and reward redeemed across the platform, filterable by shop or customer. | – |
| **Abuse monitor** | Flags for: shops with auto-approve **and** unusually high stamp counts. Customers joining many shops in a short time. Many new accounts from one IP. Shops making large imports. Customers repeatedly declined. Rate-limit hits. | Jump to the shop or customer and suspend or block it |
| **Audit log** | Every admin action: who, what, target, before and after, IP, and time. It cannot be edited. | – |
| **System** | App version, migrations applied, DB size and row counts, instance uptime. | Export tables to CSV |

### Phase 2
- **Admin users and roles:** *owner* (everything), *support* (view, resets, block; no deletes or plan changes), *viewer* (read-only).
- **Plans & billing:** subscriptions, invoices, failed payments, coupons, and trial expiries.
- **Announcements:** a banner message to all shops or to selected shops.
- **Support tickets:** if you move off WhatsApp.
- **Reward/claim admin:** void a fraudulent claim, or extend an expiry.
- **Data tools:** merge duplicate customers, and bulk-export a shop's data on request.
- **Feature flags per shop:** turn on beta features such as scratch cards for a few shops.

## 2. Design

### Architecture (fits the current app; no new framework)
- One new page, `public/admin.html`, built like `shop.html` (vanilla JS plus the same `app.css`). The visual language stays the same and there is no build step.
- The API lives at `/api/admin/*`, in a separate `admin.js` router mounted by `server.js`.
- Serve it at `/admin`, or better on its own subdomain (`admin.yourdomain`) so the admin cookie is never sent to the public app.

### Security model (the admin panel is the most valuable target in the system)
- **Separate admin accounts** in an `admin_users` table. A shop account can never become an admin.
- **Mandatory 2FA (TOTP**, Google Authenticator) on every admin login. Use Node's `crypto` for TOTP, so no new dependency is needed.
- **Short sessions:** 12 hours, plus 30 minutes idle. Customers and shops keep their one-year sessions. The admin uses its own cookie, `sid_a`, with `SameSite=Strict`.
- **Strict rate limit** on admin login (5 per 15 minutes per IP and per email). An optional `ADMIN_IP_ALLOWLIST` env setting.
- **Every write goes through one `audit()` call.** Destructive actions (delete, suspend) need a typed confirmation and a reason.
- **PII masking:** phone numbers are shown as `98765•••10` in lists. Revealing the full number is a click, and the click is logged.
- **"View as shop" is read-only** and audited. It shows a red banner and does not create a shop session.
- `X-Robots-Tag: noindex` on all admin responses.

### Database changes (one new migration, `003_admin.sql`)
```sql
CREATE TABLE admin_users(
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, pass_hash text NOT NULL,
  totp_secret text,                       -- null until 2FA is set up; login refused without it
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','support','viewer')),
  disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE sessions DROP CONSTRAINT sessions_role_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_role_check CHECK (role IN ('customer','shop','admin'));
CREATE TABLE audit_log(
  id bigserial PRIMARY KEY, admin_id int REFERENCES admin_users, action text NOT NULL,
  target_type text, target_id int, details jsonb, ip text, at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_target ON audit_log(target_type, target_id);
ALTER TABLE shops ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted'));
ALTER TABLE shops ADD COLUMN status_reason text;
ALTER TABLE customers ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked'));
ALTER TABLE customers ADD COLUMN last_seen_at timestamptz;
```
`auth()` in `server.js` then also checks the status: suspended shops and blocked customers get a 403. The first admin is created with a one-off command, `node scripts/create-admin.js email`, which prints a TOTP QR. There is no signup page.

### API (all under `/api/admin`, all audited on write)
```
POST /login            {email,password,totp}     GET  /me                POST /logout
GET  /stats            dashboard numbers + charts
GET  /shops?q=&plan=&status=&sort=&page=          GET  /shops/:id
PATCH /shops/:id       {name,phone,plan,trial_ends,...}
POST /shops/:id/suspend {reason}   POST /shops/:id/reactivate   POST /shops/:id/logout-all
GET  /customers?q=&page=                           GET  /customers/:id
PATCH /customers/:id   {name,phone_verified}
POST /customers/:id/block {reason}  POST /customers/:id/unblock  DELETE /customers/:id {reason}
GET  /resets?status=pending        POST /resets/:id/approve      POST /resets/:id/reject
GET  /activity?shop=&customer=&type=&before=      (keyset pagination)
GET  /abuse                        GET /audit?page=               GET /system
```
Lists use **server-side pagination** (50 per page, keyset on id) from the start, so they stay fast at any size.

### Screens (layout)
```
┌──────────────────────────────────────────────────────────────────────┐
│ Stampwise ADMIN                          support@… (owner)  Log out  │
├──────────────┬───────────────────────────────────────────────────────┤
│ Dashboard    │  Shops 412   Customers 18,204   Active shops 7d 233   │
│ Shops        │  Stamps today 1,930   Rewards earned 312 / redeemed 207│
│ Customers    │  ┌ New shops / day ───────┐ ┌ Stamps / day ─────────┐ │
│ Resets  (3)  │  │ ▁▂▃▅▃▆▇               │ │ ▃▄▅▆▅▇█              │ │
│ Activity     │  └────────────────────────┘ └───────────────────────┘ │
│ Abuse   (2)  │  ⚠ Abuse flags            Top shops (7 days)          │
│ Audit log    │  • Cafe X: 412 auto-approved stamps today  [Open]     │
│ System       │  • 37 new accounts from one IP in 1h       [Open]     │
└──────────────┴───────────────────────────────────────────────────────┘

Shop page
┌ Cafe X  · code K7M2QX · free plan · ACTIVE          [View as shop] [Suspend] ┐
│ Owner email · phone · joined 12 Oct · last activity 2 min ago                 │
│ Settings: card 8 · auto-approve ON · multi/day OFF                            │
│ [Customers 1,204] [Stamps 30d 3,410] [Rewards earned 211] [Redeemed 160]      │
│ Rewards ladder …   Recent requests …   Sessions (3) [Log out all]             │
│ Audit history for this shop …                                                 │
└───────────────────────────────────────────────────────────────────────────────┘
```

## 3. Questions to decide before building
1. MVP only, or MVP + admin roles (phase 2, first item)?
2. `/admin` on the same domain, or a separate `admin.` subdomain? (The subdomain is recommended.)
3. Should suspending a shop hide its card from customers, or only stop new stamps?
