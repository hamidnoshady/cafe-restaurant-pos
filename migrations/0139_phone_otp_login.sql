-- Phase 42 — phone-based OTP login for every member, and longer PINs.
--
-- What this buys, in one paragraph: the login door stops trusting a shared
-- 4-digit PIN forever. Every membership (owner, manager, accountant, cashier,
-- waiter, kitchen — the admin roles included) carries a real mobile number,
-- verified once by an SMS OTP through Kavenegar; after that the member can
-- sign in with their phone, and the PIN quick-login only works inside a
-- 7-day window anchored on their last successful OTP. Admins keep the
-- email+password door at /admin (with its own Phase 24 second factor).
--
-- Columns on users (per *membership*, not per person — the till door is a
-- business-scoped login, and the same human may work for two businesses with
-- two numbers, exactly like pin_hash is per-membership today):
--
--   phone_e164        canonical +98… form (phone.ts normalises); unique per
--                     business so the direct "type your number" login can
--                     resolve exactly one member
--   phone_verified_at set the first time an SMS OTP to that number is
--                     entered correctly; an owner retyping a member's number
--                     clears it, because a number nobody has proven is a
--                     number nobody owns
--   otp_login_at      the anchor of the 7-day PIN window: stamped on every
--                     successful phone-OTP verification
--
-- No RLS policy is needed: users is already tenant-scoped by Phase 12's
-- policies, and these columns add no new table.
--
-- The settings row below is the adoption window the deploy needs because
-- businesses are *running* on this install today: every business that already
-- exists gets `auth.phoneOtp` = { enforcedAt: now + 14 days }. Until that
-- date the PIN door behaves exactly as before — the 14 days exist so owners
-- and staff can set and verify their numbers first (team screen + the door's
-- own «تأیید شمارهٔ موبایل» step + the security center). Businesses created
-- after this migration are stamped by provisionBusiness with enforcedAt =
-- now, because a brand-new business has no legacy staff to protect.
--
-- One further guard lives in code, not here: enforcement also requires a
-- configured SMS provider (a Kavenegar key in the console or the
-- environment). A local install with no internet cannot receive SMS, so the
-- requirement would be a lockout with a friendlier name; there the policy
-- reads as "pending SMS" and the PIN door keeps working.

ALTER TABLE users
    ADD COLUMN phone_e164 text,
    ADD COLUMN phone_verified_at timestamptz,
    ADD COLUMN otp_login_at timestamptz;

-- One member per number per business. The direct phone login resolves a
-- member by (business, phone); a duplicate would make that resolution
-- ambiguous. Partial so members without a number (still inside the grace
-- window) don't collide on NULL.
CREATE UNIQUE INDEX idx_users_business_phone
    ON users (business_id, phone_e164)
    WHERE phone_e164 IS NOT NULL;

-- mfa_challenges gains a second subject realm ('employee_phone' — the column
-- has no CHECK constraint by design, unlike mfa_enrolments) and is read by
-- "latest live challenge for this subject", which had no supporting index.
CREATE INDEX idx_mfa_challenges_subject
    ON mfa_challenges (subject_realm, subject_id, created_at DESC);

-- The 14-day adoption window for every business already on this install.
INSERT INTO settings (business_id, location_id, key, value)
SELECT b.id,
       NULL,
       'auth.phoneOtp',
       jsonb_build_object('enforcedAt', to_jsonb(now() + interval '14 days'))
  FROM businesses b;
