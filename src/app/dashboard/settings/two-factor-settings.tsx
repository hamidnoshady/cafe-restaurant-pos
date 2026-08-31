"use client";

/**
 * Phase 24 Wave 2 — two-factor authentication, from inside the dashboard.
 *
 * The `/api/auth/mfa/*` interstitial only exists for someone the login route
 * has *refused* a session to. The grace window is built around the opposite
 * case: an Owner who is signed in, has seen the countdown, and wants to enrol
 * before the deadline rather than at it. This section is where that happens,
 * talking to the session-authenticated `/api/auth/mfa/self`.
 *
 * The manager opt-in below is the spec's "a business may opt to extend the
 * requirement to `manager`; off by default" — owner-only, because a manager
 * able to switch it off would be voting on whether they themselves need a
 * second factor.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { ErrorBox, InfoBox, api, errorMessage } from "../ui";
import { SectionCard } from "../page-chrome";
import { Button } from "@/components/ui/button";

type Requirement = "not_required" | "grace" | "required";

interface SelfMfa {
  applies: boolean;
  requirement: Requirement;
  graceUntil: string | null;
  graceDaysLeft: number | null;
  methods: {
    method: "totp" | "sms_otp";
    isPrimary: boolean;
    phoneHint: string | null;
    confirmedAt: string | null;
  }[];
  recoveryCodesRemaining: number;
  policy: { requireForManagers: boolean };
}

interface Handover {
  totpSecret?: string | null;
  totpQr?: string | null;
  recoveryCodes?: string[];
}

const METHOD_LABELS: Record<string, string> = {
  totp: "برنامهٔ رمزساز",
  sms_otp: "پیامک یک‌بارمصرف",
};

export function TwoFactorSettings({ isOwner }: { isOwner: boolean }) {
  const [state, setState] = useState<SelfMfa | null>(null);
  const [handover, setHandover] = useState<Handover | null>(null);
  const [phone, setPhone] = useState("");
  const [showPhone, setShowPhone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<SelfMfa & { error?: string }>("/api/auth/mfa/self");
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setState(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<Handover & { error?: string }>("/api/auth/mfa/self", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      const map: Record<string, string> = {
        invalid_phone: "شمارهٔ موبایل معتبر نیست.",
        already_enrolled: "این روش قبلاً فعال است.",
        not_enrolled: "ابتدا یک روش دومرحله‌ای فعال کنید.",
      };
      setError(map[data.error ?? ""] ?? errorMessage(data.error));
      return;
    }
    setHandover({
      totpSecret: data.totpSecret ?? null,
      totpQr: data.totpQr ?? null,
      recoveryCodes: data.recoveryCodes ?? [],
    });
    setCopied(false);
    setShowPhone(false);
    setPhone("");
    await load();
  }

  async function savePolicy(requireForManagers: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>("/api/settings/mfa-policy", {
      method: "PUT",
      body: JSON.stringify({ requireForManagers }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(
      requireForManagers
        ? "از این پس مدیران شعبه هم باید ورود دومرحله‌ای داشته باشند."
        : "الزام ورود دومرحله‌ای برای مدیران شعبه برداشته شد.",
    );
    await load();
  }

  const enrolled = (state?.methods.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <SectionCard title="ورود دومرحله‌ای حساب شما">
        {handover ? (
          <div className="space-y-4">
            <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              این اطلاعات فقط همین یک بار نمایش داده می‌شود. پس از بستن این بخش دیگر قابل بازیابی
              نیستند.
            </p>

            {handover.totpQr ? (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={handover.totpQr}
                  alt="کد QR ورود دومرحله‌ای"
                  className="size-48 rounded-lg bg-white p-2"
                />
              </div>
            ) : null}

            {handover.totpSecret ? (
              <div>
                <p className="mb-1 text-sm text-muted-foreground">
                  کد QR را با Google Authenticator اسکن کنید، یا این کد را دستی وارد کنید:
                </p>
                <p
                  dir="ltr"
                  className="rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
                >
                  {handover.totpSecret}
                </p>
              </div>
            ) : null}

            {handover.recoveryCodes && handover.recoveryCodes.length > 0 ? (
              <div>
                <p className="mb-2 text-sm text-muted-foreground">
                  ۱۰ کد بازیابی یک‌بارمصرف — اگر گوشی‌تان را از دست بدهید، تنها راه ورود همین‌هاست.
                </p>
                <div
                  dir="ltr"
                  className="grid grid-cols-2 gap-1 rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider"
                >
                  {handover.recoveryCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(handover.recoveryCodes!.join("\n"));
                        setCopied(true);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? "کپی شد" : "کپی کدها"}
                  </Button>
                </div>
              </div>
            ) : null}

            <Button type="button" onClick={() => setHandover(null)}>
              ذخیره کردم
            </Button>
          </div>
        ) : state === null ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : !state.applies ? (
          <p className="text-sm text-muted-foreground">
            ورود دومرحله‌ای برای نقش شما الزامی نیست.
          </p>
        ) : enrolled ? (
          <div className="space-y-3">
            <p className="text-sm">
              روش فعال:{" "}
              {state.methods
                .map(
                  (m) =>
                    `${METHOD_LABELS[m.method] ?? m.method}${m.phoneHint ? ` (${toPersianDigits(m.phoneHint)})` : ""}`,
                )
                .join(" + ")}
            </p>
            <p className="text-sm text-muted-foreground">
              کدهای بازیابی باقی‌مانده:{" "}
              {toPersianDigits(String(state.recoveryCodesRemaining))}
              {state.recoveryCodesRemaining <= 2
                ? " — بهتر است مجموعهٔ تازه‌ای بسازید."
                : ""}
            </p>
            <div className="flex flex-wrap gap-2">
              {!state.methods.some((m) => m.method === "totp") ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => post({ method: "totp" })}
                >
                  افزودن برنامهٔ رمزساز
                </Button>
              ) : null}
              {!state.methods.some((m) => m.method === "sms_otp") ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setShowPhone((v) => !v)}
                >
                  افزودن پیامک
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => post({ action: "regenerate_recovery_codes" })}
              >
                ساخت کدهای بازیابی تازه
              </Button>
            </div>
            {showPhone ? <PhoneField phone={phone} setPhone={setPhone} busy={busy} onSubmit={() => post({ method: "sms_otp", phone })} /> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {state.requirement === "required"
                ? "مهلت فعال‌سازی تمام شده است؛ ورود بعدی شما تا فعال‌سازی مسدود می‌شود."
                : state.graceDaysLeft !== null
                  ? `${toPersianDigits(String(state.graceDaysLeft))} روز تا اجباری‌شدن ورود دومرحله‌ای باقی مانده است.`
                  : "هنوز روش دومرحله‌ای فعال نکرده‌اید."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy} onClick={() => post({ method: "totp" })}>
                برنامهٔ رمزساز (بدون اینترنت هم کار می‌کند)
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setShowPhone((v) => !v)}
              >
                پیامک یک‌بارمصرف
              </Button>
            </div>
            {showPhone ? <PhoneField phone={phone} setPhone={setPhone} busy={busy} onSubmit={() => post({ method: "sms_otp", phone })} /> : null}
          </div>
        )}
      </SectionCard>

      {isOwner ? (
        <SectionCard title="سیاست ورود دومرحله‌ای کسب‌وکار">
          <p className="mb-4 text-sm text-muted-foreground">
            حساب مالک همیشه باید ورود دومرحله‌ای داشته باشد. می‌توانید همین الزام را به مدیران شعبه
            هم گسترش دهید. ورود کارکنان با پین تحت تأثیر قرار نمی‌گیرد.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 size-4"
              disabled={busy || state === null}
              checked={state?.policy.requireForManagers ?? false}
              onChange={(e) => savePolicy(e.target.checked)}
            />
            <span>مدیران شعبه هم باید ورود دومرحله‌ای داشته باشند.</span>
          </label>
        </SectionCard>
      ) : null}
    </div>
  );
}

function PhoneField({
  phone,
  setPhone,
  busy,
  onSubmit,
}: {
  phone: string;
  setPhone: (v: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="max-w-xs space-y-2">
      <label className="block text-sm text-muted-foreground" htmlFor="mfa-phone">
        شمارهٔ موبایل
      </label>
      <input
        id="mfa-phone"
        dir="ltr"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="09121234567"
        className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
      />
      <Button type="button" disabled={busy || phone.trim().length === 0} onClick={onSubmit}>
        ثبت شماره
      </Button>
    </div>
  );
}
