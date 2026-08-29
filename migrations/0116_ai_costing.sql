-- ============================================================================
-- 0116_ai_costing.sql — cost-plus-revenue pricing for the platform AI service.
--
-- The manual per-million sale rates are replaced by what they always really
-- were: the provider's own cost per million tokens, plus a revenue margin the
-- platform sets once. The effective sale rate is computed in the application
-- (ceil(cost * (1 + margin/100))), so `input_token_rial_per_million` and
-- `output_token_rial_per_million` become derived values and their columns are
-- dropped from the source of truth.
--
-- `credit_unit_rial` is fixed at 1: with the credit-package catalogue gone, a
-- credit is simply a Rial and the display-unit setting has nothing left to do.
-- ============================================================================

ALTER TABLE platform_ai_config
    ADD COLUMN input_cost_rial_per_million  bigint NOT NULL DEFAULT 0,
    ADD COLUMN output_cost_rial_per_million bigint NOT NULL DEFAULT 0,
    ADD COLUMN revenue_margin_percent       numeric(5, 2) NOT NULL DEFAULT 0;

-- Existing deployments keep their pricing: current rates become the cost
-- basis with a zero margin, so nothing changes for any business mid-flight.
UPDATE platform_ai_config
   SET input_cost_rial_per_million  = input_token_rial_per_million,
       output_cost_rial_per_million = output_token_rial_per_million,
       revenue_margin_percent       = 0;

ALTER TABLE platform_ai_config
    DROP COLUMN input_token_rial_per_million,
    DROP COLUMN output_token_rial_per_million,
    DROP COLUMN credit_unit_rial;
