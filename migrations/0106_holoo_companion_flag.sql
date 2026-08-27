-- ============================================================================
-- 0106_holoo_companion_flag.sql — Phase 26 / issue #125 (Wave 7)
-- The companion-mode feature flag, off by default.
--
-- Everything in companion mode is gated on this one flag: until it is on, the
-- pull tick does nothing, the ownership guard short-circuits, and no Holoo
-- surface appears. A business that never turns it on sees no change at all.
-- ============================================================================

INSERT INTO feature_flags (key, name, description, default_enabled)
VALUES (
    'holoo_companion',
    'حالت همراه هلو',
    'کار با داده‌های نرم‌افزار هلو به‌عنوان دفتر رسمی: آینهٔ فقط‌خواندنی، مالکیت هلو و تطبیق شبانه',
    false
)
ON CONFLICT (key) DO NOTHING;
