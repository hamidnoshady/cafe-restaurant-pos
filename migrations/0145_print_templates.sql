-- ============================================================================
-- 0145_print_templates.sql — طراح قالب چاپ و لوگوی کسب‌وکار
--
-- Two additions to the printing surface:
--
--   1. `print_templates` — the invoice/receipt layouts a business designs for
--      itself. The five built-in templates (src/lib/print-template.ts) stay in
--      code and are never rows: they are the starting points a shop
--      duplicates. A row here is exactly what `parsePrintTemplate` accepts —
--      paper, options and an ordered block list, in one jsonb `layout` column
--      — because the renderer, the designer screen and the print agent all
--      read the same shape and a column per option would fork the moment the
--      designer grew a control.
--
--      `is_default` picks the template a document type prints with when
--      nobody chose one at the till. At most one default per
--      (location, doc_type), enforced by a partial unique index rather than by
--      application code.
--
--   2. `business_logo` on `settings` — no schema change (the key/value
--      `settings` table already holds the business profile); this migration
--      only records the key so the convention is greppable in one place with
--      the tables it prints on:
--          key   = 'business.logo'
--          value = { "dataUrl": "data:image/png;base64,…", "width": 512,
--                    "height": 512, "updatedAt": "…" }
--      The logo is stored inline rather than as a file path on purpose: the
--      print agent renders receipts in a browser with no session and often no
--      route back to the app server, so the image has to travel inside the
--      HTML. A hard 512 KB cap is enforced in the route.
--
-- Printer rows are untouched: the extra hardware fields this phase adds
-- (transport, OS printer name, driver mode, default paper/template) all live
-- in `printers.connection`, the flexible jsonb column migration 0001 created
-- for exactly that ("ip/port/usb path/driver opts").
-- ============================================================================

CREATE TABLE IF NOT EXISTS print_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    name        text NOT NULL,
    -- Which document this layout is for: رسید / فاکتور / سفارش آشپزخانه / برچسب.
    doc_type    text NOT NULL CHECK (doc_type IN ('receipt', 'invoice', 'kitchen', 'label')),
    -- Paper key from src/lib/print-template.ts (thermal58 | thermal80 | a4 |
    -- a5 | label57x40). Kept as text, not an enum: the paper list is a product
    -- decision that grows, and every read validates it through the parser.
    paper       text NOT NULL,
    -- { options: {...}, blocks: [...] } — the parsed, normalised template.
    layout      jsonb NOT NULL,
    is_default  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, name)
);

CREATE INDEX IF NOT EXISTS idx_print_templates_location
    ON print_templates (location_id, doc_type);

-- One default per document type per branch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_print_templates_default
    ON print_templates (location_id, doc_type)
    WHERE is_default;

ALTER TABLE print_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE print_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON print_templates FOR ALL
    USING (app_rls_bypass() OR app_owns_location(location_id))
    WITH CHECK (app_rls_bypass() OR app_owns_location(location_id));
