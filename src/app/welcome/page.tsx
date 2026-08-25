"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { ModeChoice } from "./mode-choice";
import { PairForm } from "./pair-form";
import {
  ENABLED_INDUSTRIES,
  INDUSTRIES,
  INDUSTRY_LABELS,
  type Industry,
} from "@/lib/industries";

type Stage = "choosing" | "local" | "connecting";

/**
 * First-run page. On a completely empty database it asks how this install
 * should be set up — a brand-new local-only business, or an existing online
 * business claimed with a pairing code — then runs the chosen path. If the
 * install already has users, it redirects to the normal login.
 */
export default function WelcomePage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [stage, setStage] = useState<Stage>("choosing");

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

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        در حال بررسی…
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      {stage === "choosing" ? (
        <ModeChoice
          onChoose={(mode) =>
            setStage(mode === "local" ? "local" : "connecting")
          }
        />
      ) : null}
      {stage === "local" ? (
        <LocalBootstrapForm onBack={() => setStage("choosing")} />
      ) : null}
      {stage === "connecting" ? (
        <PairForm onBack={() => setStage("choosing")} />
      ) : null}
    </div>
  );
}

/** Today's bootstrap form, unchanged apart from the back link and the mode it sends. */
function LocalBootstrapForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [businessName, setBusinessName] = useState("");
  const [locationName, setLocationName] = useState("شعبه مرکزی");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [industry, setIndustry] = useState<Industry>("food_service");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/setup/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessName,
        locationName,
        ownerName,
        email,
        password,
        industry,
        deploymentMode: "local",
      }),
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
        email_password_mismatch:
          "این ایمیل قبلاً ثبت شده و گذرواژه با آن هم‌خوانی ندارد.",
        invalid_industry: "نوع کسب‌وکار نامعتبر است.",
        industry_not_available: "این نوع کسب‌وکار هنوز در دسترس نیست.",
      };
      setError(map[data.error] ?? "خطا در راه‌اندازی اولیه. دوباره تلاش کنید.");
      return;
    }
    // Bootstrap signs the Owner in; go straight to the wizard.
    router.replace("/setup/business");
  }

  return (
    <div className="w-full max-w-md rounded-2xl bg-card p-8 shadow-sm">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50 rounded-sm"
      >
        ← بازگشت
      </button>
      <h1 className="mb-1 text-2xl font-bold">راه‌اندازی محلی</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        کسب‌وکار و حساب مالک را بسازید. بعد از آن، جادوگر راه‌اندازی شما را
        قدم‌به‌قدم تا آماده‌شدن برای فروش همراهی می‌کند.
      </p>

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام کسب‌وکار *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="مثلاً کافه بهار"
            required
          />
        </label>
        <div className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نوع کسب‌وکار *
          </span>
          <div className="grid grid-cols-2 gap-2">
            {INDUSTRIES.map((option) => {
              const enabled = ENABLED_INDUSTRIES.includes(option);
              const selected = industry === option;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!enabled}
                  onClick={() => enabled && setIndustry(option)}
                  className={`relative rounded-lg border px-3 py-2 text-sm transition-colors outline-none focus-visible:ring focus-visible:ring-ring/50 ${
                    selected
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-input text-foreground"
                  } ${enabled ? "hover:border-primary/60" : "cursor-not-allowed opacity-50"}`}
                >
                  {INDUSTRY_LABELS[option]}
                  {!enabled ? (
                    <span className="absolute -top-2 -right-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      به‌زودی
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام شعبهٔ اول *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={locationName}
            onChange={(e) => setLocationName(e.target.value)}
            required
          />
        </label>
        <hr className="border-border" />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            نام مالک *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            ایمیل مالک *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
            dir="ltr"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-foreground">
            گذرواژه *
          </span>
          <input
            className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring/30"
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
          className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          {busy ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2Icon className="size-4 animate-spin" /> در حال ساخت…
            </span>
          ) : (
            "ساخت و شروع راه‌اندازی"
          )}
        </button>
      </form>
    </div>
  );
}
