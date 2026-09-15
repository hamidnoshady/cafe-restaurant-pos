/**
 * The system roles' Persian labels — one copy.
 *
 * Nine screens used to carry their own `ROLE_LABELS` map (the sidebar, the team
 * manager, the setup wizard, the login picker, the profile card…), and copies
 * drift: the wizard's copy was already missing «حسابدار» while the team screen
 * had it, so the same person was «حسابدار» in one screen and a raw `accountant`
 * string in another. A role's name is a fact about the product, not a
 * screen-local decision, so it lives beside the role type and every screen asks
 * this file.
 *
 * Framework-free and type-only imports, so both server components and `"use
 * client"` ones can use it (the same arrangement `permissions.ts` makes).
 */
import type { Role } from "./auth-edge";

/** What each system role is called in the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

/**
 * A role's label, or the raw value when it is none of the six — platform-level
 * strings and stale tokens should degrade to readable text, never to
 * `undefined` rendered as nothing.
 */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return "";
  return ROLE_LABELS[role as Role] ?? role;
}
