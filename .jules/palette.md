## 2024-10-24 - Invalid focus rings on Tailwind elements
**Learning:** Tailwind CSS does not provide a `ring-3` utility out of the box (the scale is `ring-1`, `ring-2`, `ring`, `ring-4`). This caused elements relying on `focus-visible:ring-3` to fail silently when receiving keyboard focus, resulting in an inaccessible experience.
**Action:** Always use `focus-visible:ring-2` (or the default `focus-visible:ring`) when styling elements for keyboard accessibility.
