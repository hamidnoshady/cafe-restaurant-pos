"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormLoadingSkeleton } from "@/components/form-loading-skeleton";
import { cardClass } from "@/app/dashboard/page-chrome";
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
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className={`w-full max-w-md ${cardClass} p-6`}>
          <FormLoadingSkeleton rows={3} label="در حال بررسی وضعیت راه‌اندازی" />
        </div>
      </main>
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
  /** The one-time TOTP/recovery-code handover, shown between bootstrap and the wizard. */
  const [mfa, setMfa] = useState<MfaHandover | null>(null);

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
    // Bootstrap signs the Owner in. Before handing them to the wizard, show
    // the one and only copy of their second factor: a local install enrols
    // TOTP (there is no internet for an SMS), and until Phase 24's follow-up
    // nothing displayed the secret it had just created — leaving the Owner
    // enrolled in a factor they could never satisfy.
    const data: { mfa?: MfaHandover } = await res.json().catch(() => ({}));
    setBusy(false);
    if (data.mfa && (data.mfa.totpSecret || data.mfa.recoveryCodes.length > 0)) {
      setMfa(data.mfa);
      return;
    }
    router.replace("/setup/business");
  }

  if (mfa) {
    return <MfaHandoverCard mfa={mfa} onDone={() => router.replace("/setup/business")} />;
  }

  return (
    <div className={`w-full max-w-md ${cardClass} p-8`}>
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
                      ? "border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/20 font-medium text-amber-950 dark:text-amber-200"
                      : "border-input text-foreground"
                  } ${enabled ? "hover:border-amber-400 dark:hover:border-amber-500/50" : "cursor-not-allowed opacity-50"}`}
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
          {busy ? "در حال ساخت…" : "ساخت و شروع راه‌اندازی"}
        </button>
      </form>
    </div>
  );
}

/** What `/api/setup/bootstrap` hands back once, and never again. */
interface MfaHandover {
  method: "totp" | "sms_otp";
  totpSecret: string | null;
  totpUrl: string | null;
  totpQr: string | null;
  recoveryCodes: string[];
}

/**
 * Phase 24 Wave 2 — the first-run second-factor handover.
 *
 * `provisionBusiness` has enrolled the Owner in TOTP (a local install has no
 * internet, so an SMS second factor would lock them out of their own till the
 * first time the connection dropped) and minted ten recovery codes. Both exist
 * in plaintext for exactly the length of this screen: the secret is stored
 * encrypted and the codes only as bcrypt hashes, so a reload here really does
 * lose them.
 *
 * Hence the deliberate friction — an explicit checkbox rather than a "next"
 * button. The alternative, which is what shipped before this screen existed, is
 * an Owner who discovers at their second login that they are enrolled in a
 * factor nobody ever showed them.
 */
function MfaHandoverCard({ mfa, onDone }: { mfa: MfaHandover; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className={`w-full max-w-md ${cardClass} p-8`}>
      <h1 className="mb-1 text-2xl font-bold">ورود دومرحله‌ای مالک</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        روی نصب محلی، ورود مالک با «برنامهٔ رمزساز» محافظت می‌شود؛ چون بدون اینترنت پیامکی ارسال
        نمی‌شود. این صفحه فقط همین یک بار نمایش داده می‌شود.
      </p>

      {mfa.totpQr ? (
        <div className="mb-4 flex justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={mfa.totpQr}
            alt="کد QR ورود دومرحله‌ای"
            className="size-52 rounded-lg bg-white p-2 ring-1 ring-border/80"
          />
        </div>
      ) : null}

      {mfa.totpSecret ? (
        <div className="mb-4">
          <p className="mb-1 text-sm text-muted-foreground">
            کد QR را با Google Authenticator (یا هر برنامهٔ مشابه) اسکن کنید، یا این کد را دستی وارد
            کنید:
          </p>
          <p
            dir="ltr"
            className="rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
          >
            {mfa.totpSecret}
          </p>
        </div>
      ) : null}

      {mfa.recoveryCodes.length > 0 ? (
        <div className="mb-4">
          <p className="mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
            این ۱۰ کد بازیابی را چاپ کنید یا جای امنی بنویسید. اگر گوشی‌تان را از دست بدهید، تنها
            راه ورود همین‌هاست.
          </p>
          <div
            dir="ltr"
            className="grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
          >
            {mfa.recoveryCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <button
            type="button"
            className="mt-2 w-full rounded-lg border border-input py-2 text-sm font-semibold transition hover:bg-primary/10"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(mfa.recoveryCodes.join("\n"));
                setCopied(true);
              } catch {
                // Clipboard access can be refused; the codes are on screen anyway.
                setCopied(false);
              }
            }}
          >
            {copied ? "کپی شد" : "کپی کدها"}
          </button>
        </div>
      ) : null}

      <label className="mb-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1 size-4"
        />
        <span>کد QR را اسکن کردم و کدهای بازیابی را در جای امنی ذخیره کردم.</span>
      </label>

      <button
        type="button"
        disabled={!confirmed}
        onClick={onDone}
        className="w-full rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        ادامه به راه‌اندازی
      </button>
    </div>
  );
}
