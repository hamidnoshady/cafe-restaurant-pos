-- Phase 36 — reporting views for the CRM app.
--
-- The CRM's screens answer "who is this person"; these three views answer
-- "what is happening to the customer base", and they do it through the same
-- whitelisted-view mechanism every other report uses (src/lib/reports.ts), so
-- an owner can chart them, filter them by date, export them and schedule them
-- without any of that being written twice.
--
-- Three decisions worth stating, because each one is a place the numbers could
-- have silently disagreed with the rest of the app:
--
-- 1. **The same "a purchase" rule as everywhere else.** Completed orders with a
--    `closed_at`, bucketed by `app_business_date(...)` with the location's own
--    timezone and day-start. This is what `crm-segments-service.ts`,
--    `getCustomerFile` and `recomputeRfm` all use. A customer whose file says
--    «۱۲ خرید» must be counted as twelve here too, or one of the two screens is
--    lying and nobody can tell which.
--
-- 2. **Merged records are excluded.** `merged_into_id IS NOT NULL` means this
--    row lost a merge; its orders were already repointed at the survivor, so
--    counting it would double-count the person. It is kept in the table (never
--    deleted) precisely so old references still resolve — that is exactly why
--    it must be filtered here.
--
-- 3. **`location_id` is the customer's *home branch*** — where they were
--    acquired, or where they most recently bought. A customer is owned by the
--    business, not by a branch, so this column exists only because the report
--    layer filters on it for branch-scoped API keys; the dashboard passes no
--    location and sees everyone. A customer who has never bought anything has
--    NULL here and is therefore invisible to a branch-scoped key, which is the
--    honest answer: no branch can claim them.

-- ---------------------------------------------------------------------------
-- Acquisition — one row per customer, on the business day they first bought.
-- ---------------------------------------------------------------------------
-- "How many new customers did we win last month, and what did their first
-- purchase bring in." A customer registered but never seen again is not an
-- acquisition, so this view is keyed on the first *order*, not on the record's
-- creation date.
CREATE VIEW v_customer_acquisition AS
WITH first_order AS (
    SELECT DISTINCT ON (o.customer_id)
        o.customer_id,
        o.location_id,
        app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes) AS acquired_date,
        o.total AS first_order_total
    FROM orders o
    JOIN locations l ON l.id = o.location_id
    WHERE o.customer_id IS NOT NULL
      AND o.status = 'completed'
      AND o.closed_at IS NOT NULL
    ORDER BY o.customer_id, o.closed_at
)
SELECT
    c.business_id,
    f.location_id,
    f.acquired_date,
    c.id                            AS customer_id,
    c.name                          AS customer_name,
    COALESCE(c.lifecycle_stage, 'unscored') AS lifecycle_stage,
    f.first_order_total,
    1                               AS customer_count
FROM customers c
JOIN first_order f ON f.customer_id = c.id
WHERE c.merged_into_id IS NULL;

-- ---------------------------------------------------------------------------
-- Lifetime value — one row per customer, their whole relationship so far.
-- ---------------------------------------------------------------------------
-- Backs both the CLV report and the retention/churn one: churn is not a
-- separate measurement here, it is the `lifecycle_stage` dimension over this
-- same population, which is why «ارزش مشتری» and «ماندگاری» can never disagree
-- about how many customers there are.
CREATE VIEW v_customer_value AS
WITH purchases AS (
    SELECT
        o.customer_id,
        count(*)                                                        AS order_count,
        sum(o.total)                                                    AS total_spent,
        avg(o.total)                                                    AS average_order,
        min(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS first_purchase_date,
        max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS last_purchase_date,
        (array_agg(o.location_id ORDER BY o.closed_at DESC))[1]         AS home_location_id
    FROM orders o
    JOIN locations l ON l.id = o.location_id
    WHERE o.customer_id IS NOT NULL
      AND o.status = 'completed'
      AND o.closed_at IS NOT NULL
    GROUP BY o.customer_id
)
SELECT
    c.business_id,
    p.home_location_id                       AS location_id,
    p.last_purchase_date,
    c.id                                     AS customer_id,
    c.name                                   AS customer_name,
    COALESCE(c.lifecycle_stage, 'unscored')  AS lifecycle_stage,
    p.order_count,
    p.total_spent,
    round(p.average_order)                   AS average_order,
    p.first_purchase_date,
    (CURRENT_DATE - p.last_purchase_date)    AS days_since_last_purchase,
    -- The span the relationship has actually lasted. `+ 1` so a customer who
    -- bought once counts as one day rather than zero — a zero would make any
    -- per-day rate computed from this column divide by nothing.
    (p.last_purchase_date - p.first_purchase_date) + 1 AS relationship_days
FROM customers c
JOIN purchases p ON p.customer_id = c.id
WHERE c.merged_into_id IS NULL;

-- ---------------------------------------------------------------------------
-- Consent coverage — one row per customer, per channel reachability.
-- ---------------------------------------------------------------------------
-- The distinction this view exists to preserve: **granted** and **reachable**
-- are different numbers. Someone can tick "yes, text me" and have no phone
-- number on file. Reporting only the permission would promise an audience that
-- cannot be delivered to, so both are columns and the report shows the gap.
CREATE VIEW v_customer_consent AS
SELECT
    c.business_id,
    NULL::uuid                          AS location_id,
    c.created_at::date                  AS registered_date,
    c.id                                AS customer_id,
    c.name                              AS customer_name,
    CASE WHEN c.sms_consent THEN 1 ELSE 0 END        AS sms_granted,
    CASE WHEN c.marketing_consent THEN 1 ELSE 0 END  AS email_granted,
    CASE WHEN c.sms_consent AND c.phone_e164 IS NOT NULL THEN 1 ELSE 0 END AS sms_reachable,
    CASE WHEN c.marketing_consent AND c.email IS NOT NULL AND c.email <> '' THEN 1 ELSE 0 END AS email_reachable,
    CASE
        WHEN c.sms_consent AND c.marketing_consent THEN 'هر دو کانال'
        WHEN c.sms_consent THEN 'فقط پیامک'
        WHEN c.marketing_consent THEN 'فقط ایمیل'
        ELSE 'بدون اجازه'
    END                                 AS consent_state,
    1                                   AS customer_count
FROM customers c
WHERE c.merged_into_id IS NULL;

-- Views run with the caller's rights, so RLS still applies. Migration 0021's
-- loop only covered the views that existed then; these three are new and must
-- say so themselves, or they would quietly read across every tenant.
ALTER VIEW v_customer_acquisition SET (security_invoker = on);
ALTER VIEW v_customer_value SET (security_invoker = on);
ALTER VIEW v_customer_consent SET (security_invoker = on);
