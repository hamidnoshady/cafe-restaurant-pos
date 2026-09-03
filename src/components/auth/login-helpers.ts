"use client";

/**
 * Shared pieces of the two tenant sign-in screens.
 *
 * Since the login split, the tenant origin has two separate doors: the staff
 * quick login at `/login` (name-then-PIN, plus biometrics) and the
 * owner/manager password login at `/admin`. Both need the same two helpers —
 * where a successful sign-in should go, and how a lockout is worded — so they
 * live here instead of being duplicated (and drifting) across the two forms.
 */
import { useSearchParams } from "next/navigation";
import { toPersianDigits } from "@/lib/digits";

/**
 * Where to go after signing in.
 *
 * `?next=` is set by middleware and by the host resolver so a deep link
 * survives the login page — Phase 34 depends on it concretely: an owner
 * following Claude's "connect" button lands on `/mcp/consent?…`, and dropping
 * that URL abandons an OAuth flow they have no way to restart from inside the
 * app.
 *
 * Only ever a same-site path. Without the second test a protocol-relative
 * `//evil.example` is a URL too, which is how a login page becomes an open
 * redirect — the same check `/api/host/redirect` makes on the value it forwards.
 */
export function useNextPath(fallback: string): string {
  const params = useSearchParams();
  const requested = params.get("next");
  return requested && requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : fallback;
}

/**
 * A 423 (`account_locked`) from a credential exchange, worded with the concrete
 * wait time instead of the generic "wrong credentials" text — reporting a
 * lockout as "wrong password/PIN" sends the user back to re-check a credential
 * that is perfectly correct, and to keep trying, which is exactly what extends
 * the lockout.
 */
export function lockoutMessage(lockedUntil: unknown): string {
  const until = typeof lockedUntil === "string" ? new Date(lockedUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return "به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است.";
  }
  const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است؛ ${toPersianDigits(String(minutes))} دقیقه دیگر دوباره تلاش کنید.`;
}
