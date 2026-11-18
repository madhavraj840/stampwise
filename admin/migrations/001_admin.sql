-- Admin panel tables, in their own schema so they never clash with a project's tables.
CREATE SCHEMA IF NOT EXISTS admin;
CREATE TABLE IF NOT EXISTS admin.admin_users(
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, pass_hash text NOT NULL,
  totp_secret text NOT NULL,                 -- encrypted with ADMIN_SECRET; 2FA is mandatory
  totp_last bigint NOT NULL DEFAULT 0,       -- last used time step: a code works once
  role text NOT NULL CHECK (role IN ('owner','support','viewer')),
  projects text[],                           -- null = every project
  token_ver int NOT NULL DEFAULT 0, disabled boolean NOT NULL DEFAULT false,
  fails int NOT NULL DEFAULT 0, locked_until timestamptz, last_login timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS admin.audit_log(
  id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(),
  admin_id int REFERENCES admin.admin_users, admin_email text NOT NULL,
  project text, entity text, target text, action text NOT NULL, reason text, detail jsonb, ip text);
-- append-only: nobody (including the app) can edit or delete history
CREATE OR REPLACE FUNCTION admin.audit_readonly() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'audit_log is append-only'; END$$;
DROP TRIGGER IF EXISTS audit_readonly ON admin.audit_log;
CREATE TRIGGER audit_readonly BEFORE UPDATE OR DELETE ON admin.audit_log FOR EACH ROW EXECUTE FUNCTION admin.audit_readonly();
