"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
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
