"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOutIcon } from "lucide-react";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

/**
 * Signs out and returns the visitor to the door they sign back in through.
 *
 * Since the login split a tenant's origin has two of them: the staff quick
 * login at `/login` and the owner/manager password login at `/admin`. The
 * sidebar picks the one matching the signed-in role; the default stays the
 * staff door because that is what the tenant origin itself is.
 *
 * `compact` is the collapsed rail's icon-only form — the sign-out used to
 * disappear entirely when the sidebar narrowed, which is the one control that
 * should never need a hunt.
 */
export function LogoutButton({
  returnTo = "/login",
  compact = false,
}: {
  returnTo?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    // Signing out is a one-way action on a shared floor terminal: a second tap
    // while the first request is in flight used to fire a second logout.
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push(returnTo);
      router.refresh();
    } catch {
      // Offline: the session cookie is still local, so let them try again
      // rather than stranding them on a dead button.
      setBusy(false);
    }
  }

  if (compact) {
    return (
      <button
        type="button"
        onClick={logout}
        disabled={busy}
        aria-label="خروج از حساب"
        title="خروج از حساب"
        className="flex size-9 items-center justify-center rounded-lg border border-input text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:pointer-events-none disabled:opacity-50"
      >
        <LogOutIcon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
      </button>
    );
  }

  return (
    <button type="button" onClick={logout} disabled={busy} className={SIDEBAR_FOOTER_BUTTON_CLASS}>
      <LogOutIcon aria-hidden="true" className="size-4 shrink-0 rtl:rotate-180" />
      <span className="min-w-0 flex-1 truncate text-start">{busy ? "در حال خروج…" : "خروج"}</span>
    </button>
  );
}
