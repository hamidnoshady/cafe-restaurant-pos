"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * First-run page. On a completely empty database it collects the business +
 * first Owner account, bootstraps them, and hands off to the wizard. If the
 * install already has users, it redirects to the normal login.
 */
export default function WelcomePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/setup/state")
      .then((r) => r.json())
      .then((s: { needsBootstrap?: boolean }) => {
        if (!s.needsBootstrap) {
          router.replace("/login");
        } else {
          setChecking(false);
        }
      })
      .catch(() => setChecking(false));
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/setup/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, locationName, ownerName, email, password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setBusy(false);
      if (data.error === "already_initialized") {
        router.replace("/login");
        return;
      }
      const map: Record<string, string> = {
        missing_fields: "همهٔ فیلدهای الزامی را پر کنید.",
        invalid_email: "ایمیل معتبر نیست.",
        weak_password: "گذرواژه باید حداقل ۸ کاراکتر باشد.",
      };
      setError(map[data.error] ?? "خطا در راه‌اندازی اولیه. دوباره تلاش کنید.");
      return;
    }
    // Bootstrap signs the Owner in; go straight to the wizard.
    router.replace("/setup/business");
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-stone-400">
        در حال بررسی…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold">به سیستم فروش خوش آمدید</h1>
        <p className="mb-6 text-sm text-stone-500">
          برای شروع، کسب‌وکار و حساب مالک را بسازید. بعد از آن، جادوگر راه‌اندازی شما را قدم‌به‌قدم
          تا آماده‌شدن برای فروش همراهی می‌کند.
        </p>

        {error ? (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">نام کسب‌وکار *</span>
            <input
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              placeholder="مثلاً کافه بهار"
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">نام شعبهٔ اول *</span>
            <input
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              required
            />
          </label>
          <hr className="border-stone-100" />
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">نام مالک *</span>
            <input
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">ایمیل مالک *</span>
            <input
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              dir="ltr"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-stone-700">گذرواژه *</span>
            <input
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
              dir="ltr"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="حداقل ۸ کاراکتر"
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-amber-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {busy ? "در حال ساخت…" : "ساخت و شروع راه‌اندازی"}
          </button>
        </form>
      </div>
    </div>
  );
}
