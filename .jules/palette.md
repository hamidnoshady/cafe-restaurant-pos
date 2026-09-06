## 2026-08-11 - PinPad Screen Reader Support
**Learning:** The custom 4-digit PinPad component (used for login and lock screens) lacked critical context for screen reader users. The "PIN entered" dots had no programmatic association, the Backspace icon was read literally as "⌫" (or ignored), and status/error messages weren't proactively announced when changed.
**Action:** Always wrap custom progress indicators in `role="progressbar"` with dynamic `aria-valuenow`. Use `role="alert"` for errors and `role="status"` for non-error updates (like "verifying..."). Explicitly assign `aria-label` to custom keypad buttons, especially for symbols like "⌫" -> "پاک کردن آخرین رقم". Ensure all custom buttons receive `focus-visible` ring styling for keyboard navigation clarity.

## 2024-05-18 - Native tooltips for icon-only buttons
**Learning:** Even when `aria-label` is present for screen readers, sighted keyboard and mouse users benefit from native tooltips on icon-only buttons (like the theme toggle) to quickly understand their function without clicking.
**Action:** Always add a `title` attribute matching the `aria-label` on icon-only buttons, especially in global navigation areas.

## 2025-02-18 - [Add aria-labels to cart quantity and remove buttons]
**Learning:** Screen readers need context when navigating by buttons. A list of identical "حذف" (Delete), "+" and "-" buttons without descriptive aria-labels makes it impossible to know *what* is being deleted or adjusted without navigating to the surrounding text.
**Action:** Always append the item name to the `aria-label` for repeated buttons in lists or carts (e.g. `aria-label={"حذف " + item.name}`). This is a standard pattern for screen readers.
## 2026-08-24 - [Focus Ring Classes]
 **Learning:** Avoid `ring-3` as it is not a standard Tailwind CSS class and may result in a missing focus ring.
 **Action:** Use `focus-visible:ring focus-visible:ring-ring/50 outline-none` when adding or fixing focus states.

## 2024-05-24 - Missing Focus Rings due to Non-Standard Tailwind Class
**Learning:** Using `ring-3` for focus states (`focus-visible:ring-3`) causes the focus ring to be entirely missing because it is not a standard Tailwind CSS class. Standard classes are `ring`, `ring-0`, `ring-1`, `ring-2`, `ring-4`, etc.
**Action:** Always use standard Tailwind classes like `focus-visible:ring` or `focus-visible:ring-2` (along with `focus-visible:ring-ring/50 outline-none`) when building custom interactive components or fixing focus accessibility to ensure the ring renders correctly.
## 2026-08-30 - Ensure Custom Buttons Have Focus States
**Learning:** Interactive elements like custom `button` tags used in complex AI UI components often miss keyboard focus states, reducing accessibility for keyboard users navigating chat tools.
**Action:** Always append `outline-none focus-visible:ring focus-visible:ring-ring/50` to custom `<button>` elements to ensure standard Tailwind focus rings are applied for keyboard navigation.

## 2025-02-18 - Loading States in Form Buttons
**Learning:** The project's design system explicitly bans the use of `animate-spin` (spinners) inside action buttons (e.g., during async form submissions), as enforced by `design-lint.test.ts`. Loading feedback for buttons must rely strictly on swapping the text label (e.g., to 'در حال ارسال…') and disabling the button.
**Action:** Never add spinners to form buttons to indicate loading. If an async action needs a loading state, swap the text label and disable the button instead. Save spinners/skeletons for region placeholders.
