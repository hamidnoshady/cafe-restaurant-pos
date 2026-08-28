/**
 * The Growth app's section keys (Phase 36b) — plain, directive-free, so both
 * halves of the app can import them as *values*: the server page validates its
 * `?section=` deep link against this list, and the client manager renders it.
 *
 * A `"use client"` module's exports are stubs on the server (a client
 * reference proxy), which is why this list does not live in
 * `growth-manager.tsx` next to the sections it names: the page would get a
 * proxy and `.includes` would throw at request time. Icons and labels stay
 * client-side; the keys are shared.
 */

export const GROWTH_SECTION_KEYS = [
  "overview",
  "campaigns",
  "gift-cards",
  "loyalty",
  "commission",
] as const;

export type GrowthSectionKey = (typeof GROWTH_SECTION_KEYS)[number];
