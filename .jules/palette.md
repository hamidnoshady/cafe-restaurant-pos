## 2026-08-11 - PinPad Screen Reader Support
**Learning:** The custom 4-digit PinPad component (used for login and lock screens) lacked critical context for screen reader users. The "PIN entered" dots had no programmatic association, the Backspace icon was read literally as "⌫" (or ignored), and status/error messages weren't proactively announced when changed.
**Action:** Always wrap custom progress indicators in `role="progressbar"` with dynamic `aria-valuenow`. Use `role="alert"` for errors and `role="status"` for non-error updates (like "verifying..."). Explicitly assign `aria-label` to custom keypad buttons, especially for symbols like "⌫" -> "پاک کردن آخرین رقم". Ensure all custom buttons receive `focus-visible` ring styling for keyboard navigation clarity.

## 2024-05-18 - Native tooltips for icon-only buttons
**Learning:** Even when `aria-label` is present for screen readers, sighted keyboard and mouse users benefit from native tooltips on icon-only buttons (like the theme toggle) to quickly understand their function without clicking.
**Action:** Always add a `title` attribute matching the `aria-label` on icon-only buttons, especially in global navigation areas.
