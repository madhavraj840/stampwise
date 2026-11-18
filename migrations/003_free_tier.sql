-- 003: free-tier architecture + admin hooks + fix.md features.
-- Sessions move into signed cookies; logging out every device = bump token_ver.
DROP TABLE IF EXISTS sessions;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS token_ver int NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS token_ver int NOT NULL DEFAULT 0;

-- admin controls
ALTER TABLE shops ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'));
ALTER TABLE shops ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deleted'));
-- a deleted customer keeps the row (so shops keep their reward history) but loses the phone number and name
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;

-- shop profile: pause switch, review + social links, logo
ALTER TABLE shops ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS review_url text;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS instagram text;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS whatsapp text;
ALTER TABLE shops ADD COLUMN IF NOT EXISTS logo_ver int NOT NULL DEFAULT 0;   -- 0 = no logo; bumps on every upload (cache-busting URL)
CREATE TABLE IF NOT EXISTS shop_logos(shop_id int PRIMARY KEY REFERENCES shops ON DELETE CASCADE, type text NOT NULL, img bytea NOT NULL);

-- cards: counters kept up to date by the queries that change them, so lists never count rows.
-- updated_at lets the dashboard download only what changed; removed_at = soft delete (history stays)
ALTER TABLE cards ADD COLUMN IF NOT EXISTS earned int NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS redeemed int NOT NULL DEFAULT 0;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE cards ADD COLUMN IF NOT EXISTS removed_at timestamptz;
CREATE INDEX IF NOT EXISTS cards_sync ON cards(shop_id, updated_at);
UPDATE cards k SET earned=(SELECT count(*) FROM claims l WHERE l.customer_id=k.customer_id AND l.shop_id=k.shop_id),
  redeemed=(SELECT count(*) FROM claims l WHERE l.customer_id=k.customer_id AND l.shop_id=k.shop_id AND l.status='redeemed');

-- claims: which card cycle a reward belongs to (a reward is given once per cycle, whenever its step is reached or passed)
ALTER TABLE claims ADD COLUMN IF NOT EXISTS cycle int NOT NULL DEFAULT -1;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE claims l SET cycle=k.cycles FROM cards k, rewards r
  WHERE k.customer_id=l.customer_id AND k.shop_id=l.shop_id AND r.id=l.reward_id AND r.stamps_required<=k.stamps;
UPDATE claims SET updated_at=coalesce(redeemed_at,earned_at);
CREATE INDEX IF NOT EXISTS claims_sync ON claims(shop_id, updated_at);
CREATE INDEX IF NOT EXISTS claims_cycle ON claims(customer_id, reward_id, cycle);
-- a deleted customer's rewards stay in the shop's history
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_customer_id_fkey;
ALTER TABLE claims ADD CONSTRAINT claims_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers ON DELETE SET NULL;
ALTER TABLE claims ALTER COLUMN customer_id DROP NOT NULL;

-- anti-fraud lookups (requests per customer in the last hour / day)
CREATE INDEX IF NOT EXISTS req_recent ON stamp_requests(customer_id, created_at);
-- staff accounts are not built yet: decided_by will hold the staff member who approved (null = owner)
ALTER TABLE stamp_requests ADD COLUMN IF NOT EXISTS decided_by int;
CREATE TABLE IF NOT EXISTS shop_staff(
  id serial PRIMARY KEY, shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  name text NOT NULL, email text UNIQUE NOT NULL, pass_hash text NOT NULL,
  role text NOT NULL DEFAULT 'staff' CHECK (role IN ('staff')),  -- approve-only; more roles later
  token_ver int NOT NULL DEFAULT 0, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());

-- one row per shop per day (India time), updated together with each event. Charts and admin stats read these, never raw history
CREATE TABLE IF NOT EXISTS shop_days(
  shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE, day date NOT NULL,
  stamps int NOT NULL DEFAULT 0, new_customers int NOT NULL DEFAULT 0, earned int NOT NULL DEFAULT 0, redeemed int NOT NULL DEFAULT 0,
  PRIMARY KEY(shop_id, day));
INSERT INTO shop_days(shop_id,day,stamps,new_customers,earned,redeemed)
SELECT shop_id,day,sum(a)::int,sum(b)::int,sum(c)::int,sum(d)::int FROM (
  SELECT shop_id,(decided_at AT TIME ZONE 'Asia/Kolkata')::date AS day,1 a,0 b,0 c,0 d FROM stamp_requests WHERE status='approved'
  UNION ALL SELECT shop_id,(created_at AT TIME ZONE 'Asia/Kolkata')::date,0,1,0,0 FROM cards
  UNION ALL SELECT shop_id,(earned_at AT TIME ZONE 'Asia/Kolkata')::date,0,0,1,0 FROM claims
  UNION ALL SELECT shop_id,(redeemed_at AT TIME ZONE 'Asia/Kolkata')::date,0,0,0,1 FROM claims WHERE status='redeemed') x
GROUP BY shop_id,day ON CONFLICT DO NOTHING;

-- web push subscriptions (shop devices)
CREATE TABLE IF NOT EXISTS push_subs(
  endpoint text PRIMARY KEY, shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  p256dh text NOT NULL, auth text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS push_shop ON push_subs(shop_id);

-- rate limits shared by every server instance (only used on rare actions: login, signup, password reset)
CREATE TABLE IF NOT EXISTS rate_limits(k text PRIMARY KEY, n int NOT NULL, reset_at timestamptz NOT NULL);
