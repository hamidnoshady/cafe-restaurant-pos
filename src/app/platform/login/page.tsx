"use client";

/**
 * Phase 15 — the super-admin console's own front door.
 *
 * A separate login from the tenant one, POSTing to the platform auth realm
 * (`/api/platform/auth/login`) which sets the `pos_platform_session` cookie —
 * never the tenant `pos_session`. Deliberately spartan and dark, so an operator
 * is never in doubt about which realm they are entering.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage, ErrorBox, Field, inputClass } from "../ui";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    });
    setBusy(false);
    if (ok) {
      router.push("/platform");
      router.refresh();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-white">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl">
        <div className="mb-6 text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-sky-400/80">
            Platform Console
          </p>
          <h1 className="mt-2 text-lg font-bold">کنسول مدیریت سکو</h1>
          <p className="mt-1 text-sm text-white/40">ورود مدیران سکو</p>
        </div>

        <form onSubmit={submit}>
          <ErrorBox>{error}</ErrorBox>
          <Field label="ایمیل">
            <input
              type="email"
              dir="ltr"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} text-start`}
            />
          </Field>
          <Field label="رمز عبور">
            <input
              type="password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="mt-2">
            <button
              type="submit"
              disabled={busy}
              className="h-10 w-full rounded-lg bg-sky-500 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "در حال ورود…" : "ورود"}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
