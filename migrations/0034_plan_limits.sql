-- Phase 17 — per-plan ceilings (branches, members, orders/month).
--
-- businesses.plan (migration 0020) has been a free-text label with no
-- catalogue and no limits behind it ("Plans are assigned by hand (no
-- billing)" — platform-service.ts). This gives it one: a global catalogue
-- table, mirroring feature_flags' shape (no RLS — this is not tenant data,
-- it's the same handful of rows every business reads), plus an FK so
-- businesses.plan can no longer drift to a value with no defined limits.

CREATE TABLE plans (
  key text PRIMARY KEY,
  name text NOT NULL,
  branch_limit integer,        -- NULL = unlimited
  member_limit integer,        -- NULL = unlimited
  monthly_order_limit integer, -- NULL = unlimited
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (key, name, branch_limit, member_limit, monthly_order_limit) VALUES
  ('free', 'رایگان', 1, 5, 500),
  ('pro', 'حرفه‌ای', 5, 20, 5000),
  ('business', 'سازمانی', NULL, NULL, NULL);

-- Pre-existing free-text values (this project has no billing yet, so in
-- practice this is just the 'standard' default) land on the closest
-- equivalent tier rather than being left dangling once the FK below applies.
UPDATE businesses SET plan = 'pro' WHERE plan NOT IN (SELECT key FROM plans);

ALTER TABLE businesses ALTER COLUMN plan SET DEFAULT 'free';
ALTER TABLE businesses
  ADD CONSTRAINT businesses_plan_fkey FOREIGN KEY (plan) REFERENCES plans(key);
