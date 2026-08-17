-- Phase 27 Wave 10 — the watch flagship: service reminders, pre-owned intake,
-- and a repair estimate → approval step — plus opening the (already generic)
-- repair_tickets module to jewelry.
--
-- Pre-owned provenance lives on the serial: a condition grade, the box-and-
-- papers checklist, and a flag saying the unit was bought in used. Service
-- reminders derive from serial_warranties plus sale date, so no new calendar
-- table is needed. A repair estimate is a number recorded on the ticket with
-- its own approval timestamp — closing a ticket with an unapproved estimate
-- is refused by the service layer.

ALTER TABLE item_serials
    ADD COLUMN condition_grade text
      CHECK (condition_grade IS NULL OR condition_grade IN ('new', 'like_new', 'good', 'fair', 'poor')),
    -- جعبه و مدارک — the provenance checklist for a pre-owned piece.
    ADD COLUMN box_and_papers boolean NOT NULL DEFAULT false,
    -- True when the unit was bought in used (خرید دست‌دوم), not new from the maker.
    ADD COLUMN pre_owned boolean NOT NULL DEFAULT false;

-- How often this model should be serviced (a quartz battery is ~2 years, an
-- automatic movement 3–5). The due-for-service list derives from the sale
-- date plus this interval. NULL = no service reminder for this model.
ALTER TABLE items
    ADD COLUMN service_interval_months integer
      CHECK (service_interval_months IS NULL OR (service_interval_months > 0 AND service_interval_months <= 120));

ALTER TABLE repair_tickets
    ADD COLUMN estimated_total_rial bigint NOT NULL DEFAULT 0 CHECK (estimated_total_rial >= 0),
    -- The printed estimate breaks the total into labour and parts, so the
    -- customer signs a document that says what each costs.
    ADD COLUMN estimated_labor_rial bigint NOT NULL DEFAULT 0 CHECK (estimated_labor_rial >= 0),
    ADD COLUMN estimated_parts_rial bigint NOT NULL DEFAULT 0 CHECK (estimated_parts_rial >= 0),
    ADD COLUMN estimated_at timestamptz,
    ADD COLUMN estimate_approved_at timestamptz;

-- Repair revenue (4800) and parts expense (5130) are watch-only today; a
-- jewelry business using the shared repair_tickets workflow needs them too.
INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
SELECT b.id, p.id, v.code, v.name, v.type::account_type, 'kol'::account_level, false
FROM businesses b
CROSS JOIN (VALUES ('4800', 'درآمد تعمیرات', 'revenue'), ('5130', 'بهای قطعات مصرفی تعمیرات', 'expense')) v(code, name, type)
JOIN accounts p ON p.business_id = b.id AND p.code = CASE WHEN v.code = '4800' THEN '4000' ELSE '5000' END
WHERE b.industry = 'jewelry'
ON CONFLICT (business_id, code) DO NOTHING;
