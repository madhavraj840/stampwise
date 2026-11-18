CREATE TABLE IF NOT EXISTS shops(
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  email text UNIQUE NOT NULL, pass_hash text NOT NULL,
  phone text, address text, hours text,
  card_size int NOT NULL DEFAULT 8 CHECK (card_size BETWEEN 2 AND 30),
  auto_approve boolean NOT NULL DEFAULT false,
  multi_per_day boolean NOT NULL DEFAULT false,
  plan text NOT NULL DEFAULT 'free',            -- room for paid plans later
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS customers(
  id serial PRIMARY KEY, phone text UNIQUE NOT NULL, name text NOT NULL,
  phone_verified boolean NOT NULL DEFAULT false, -- flips to true when OTP is added
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS cards(
  customer_id int REFERENCES customers ON DELETE CASCADE,
  shop_id int REFERENCES shops ON DELETE CASCADE,
  stamps int NOT NULL DEFAULT 0, visits int NOT NULL DEFAULT 0, cycles int NOT NULL DEFAULT 0,
  last_visit timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id, shop_id));
CREATE TABLE IF NOT EXISTS stamp_requests(
  id serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers ON DELETE CASCADE,
  shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON stamp_requests(customer_id, shop_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS req_shop ON stamp_requests(shop_id, status);
CREATE TABLE IF NOT EXISTS rewards(
  id serial PRIMARY KEY, shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  title text NOT NULL, stamps_required int NOT NULL CHECK (stamps_required >= 1),
  expiry_days int NOT NULL DEFAULT 30, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS claims(
  id serial PRIMARY KEY, reward_id int REFERENCES rewards ON DELETE SET NULL,
  shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  customer_id int NOT NULL REFERENCES customers ON DELETE CASCADE,
  title text NOT NULL,                           -- snapshot, survives reward edits
  status text NOT NULL DEFAULT 'earned' CHECK (status IN ('earned','redeemed')),
  earned_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, redeemed_at timestamptz);
CREATE INDEX IF NOT EXISTS claims_c ON claims(customer_id);
CREATE INDEX IF NOT EXISTS claims_s ON claims(shop_id, status);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash text PRIMARY KEY, role text NOT NULL CHECK (role IN ('customer','shop')),
  subject_id int NOT NULL, expires_at timestamptz NOT NULL);

-- v2 additions (safe to re-run)
ALTER TABLE shops ADD COLUMN IF NOT EXISTS code text;
UPDATE shops SET code=upper(substr(md5(random()::text||id::text),1,6)) WHERE code IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shops_code ON shops(code);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS code text;
UPDATE claims SET code=lpad(floor(random()*10000)::int::text,4,'0') WHERE code IS NULL;
CREATE INDEX IF NOT EXISTS cards_shop ON cards(shop_id);
CREATE INDEX IF NOT EXISTS req_cust ON stamp_requests(customer_id, shop_id, status);

-- the phone number is the customer's identity: keep it clean (10-digit Indian mobile)
DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_phone_fmt CHECK (phone ~ '^[6-9][0-9]{9}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- password reset requests (approved manually by the owner, see README)
CREATE TABLE IF NOT EXISTS password_resets(
  id serial PRIMARY KEY, shop_id int NOT NULL REFERENCES shops ON DELETE CASCADE,
  ref text NOT NULL, email text NOT NULL, shop_name text, shop_phone text,
  new_pass_hash text NOT NULL,                  -- the new password the shop chose, already hashed: same format as shops.pass_hash
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','rejected','expired')),
  requested_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);
CREATE INDEX IF NOT EXISTS resets_shop ON password_resets(shop_id, status);

-- stamp glyph the shop prints on cards
ALTER TABLE shops ADD COLUMN IF NOT EXISTS stamp_icon text NOT NULL DEFAULT 'star';
