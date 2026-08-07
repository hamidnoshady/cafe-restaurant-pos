## 2024-08-07 - Accessible Quantity Modifier Buttons
**Learning:** Icon-only increment/decrement buttons in order panels frequently lack proper screen-reader labels and visible focus rings in early implementations, making keyboard navigation difficult in high-traffic POS views.
**Action:** Always add `aria-label` (e.g. `کاهش تعداد`, `افزایش تعداد`) and standard `focus-visible` ring utility classes to interactive elements using bare symbols.
