"use client";

import { useRouter } from "next/navigation";

/**
 * Signs out and returns the visitor to the door they sign back in through.
 *
 * Since the login split a tenant's origin has two of them: the staff quick
 * login at `/login` and the owner/manager password login at `/admin`. The
 * sidebar picks the one matching the signed-in role; the default stays the
 * staff door because that is what the tenant origin itself is.
 */
export function LogoutButton({ returnTo = "/login" }: { returnTo?: string }) {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push(returnTo);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={logout}
      className="w-full rounded-lg border border-input py-1.5 text-sm text-muted-foreground transition hover:bg-muted/50"
    >
      خروج
    </button>
  );
}
