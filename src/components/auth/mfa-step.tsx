"use client";

/**
 * Phase 24 Wave 2 — the second-factor screen, for both login realms.
 *
 * The backend for this shipped complete (`/api/auth/mfa/*` and its
 * `/api/platform/auth/mfa/*` twin) and nothing in the product ever called it:
 * an Owner past the grace window received an `mfaToken` and a blank stare. This
 * is the missing half.
 *
 * One component serves both front doors because the *flow* is identical — enrol
 * if there is no factor yet, challenge, verify, or fall back to a recovery
 * code — and only the paint differs. The two realms' visual identities are
 * deliberately distinct (a light tenant card, a dark console card, so an
 * operator is never in doubt which realm they are in), so the palette arrives
 * as a `theme` prop rather than being negotiated with Tailwind variants.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";

export type MfaMethod = "totp" | "sms_otp";

export interface MfaEndpoints {
  challenge: string;
  verify: string;
  enrol: string;
}

export interface MfaTheme {
  card: string;
  heading: string;
  muted: string;
  input: string;
  primaryButton: string;
  secondaryButton: string;
  linkButton: string;
  error: string;
  notice: string;
  codeBlock: string;
}

/** The tenant login page's palette — the light card in src/app/login. */
export const TENANT_MFA_THEME: MfaTheme = {
  card: "space-y-4",
  heading: "text-base font-bold",
  muted: "text-sm text-muted-foreground",
  input:
    "w-full rounded-lg border border-input px-3 py-2 text-center text-lg tracking-[0.4em] focus:border-primary focus:outline-none",
  primaryButton:
    "w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50",
  secondaryButton:
    "w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50",
  linkButton:
    "rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50",
  error: "text-sm text-destructive",
  notice: "rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm",
  codeBlock:
    "rounded-lg border border-input bg-muted/50 px-3 py-2 font-mono text-sm tracking-wider",
};

/** The console's palette — semantic tokens keep its login flow theme-aware. */
export const PLATFORM_MFA_THEME: MfaTheme = {
  card: "space-y-4 text-foreground",
  heading: "text-base font-bold",
  muted: "text-sm text-muted-foreground",
  input:
    "h-11 w-full rounded-lg border border-border bg-transparent px-3 text-center text-lg tracking-[0.4em] text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20",
  primaryButton:
    "h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50",
  secondaryButton:
    "h-10 w-full rounded-lg border border-border text-sm font-semibold text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50",
  linkButton:
    "rounded text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline outline-none focus-visible:ring focus-visible:ring-ring/50",
  error:
    "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
  notice:
    "rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary",
  codeBlock:
    "rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm tracking-wider text-foreground",
};

/** Persian for the error codes the three MFA endpoints return. */
function mfaErrorMessage(
  code: string | undefined,
  status: number,
  serverMessage?: string,
): string {
  const map: Record<string, string> = {
    invalid_code: "کد واردشده درست نیست.",
    invalid_recovery_code:
      "این کد بازیابی معتبر نیست یا قبلاً استفاده شده است.",
    missing_code: "کد را وارد کنید.",
    not_enrolled: "برای این حساب هیچ روش دومرحله‌ای ثبت نشده است.",
    invalid_method: "روش انتخاب‌شده معتبر نیست.",
    invalid_phone: "شمارهٔ موبایل معتبر نیست.",
    already_enrolled: "این روش قبلاً برای حساب شما ثبت شده است.",
    missing_phone: "برای این حساب شمارهٔ موبایلی ثبت نشده است.",
    sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
    unauthorized: "مهلت این مرحله تمام شده است؛ دوباره وارد شوید.",
    no_business_membership: "دسترسی شما به این کسب‌وکار برقرار نیست.",
  };
  // The SMS challenge route hands back Kavenegar's own status mapped to
  // Persian when — and only when — the fault is something the user can act on
  // (a bad receptor, say, rather than the platform's empty credit balance).
  // That sentence is more useful than the generic one, so it wins.
  if (serverMessage) return serverMessage;
  if (code && map[code]) return map[code];
  if (status === 401) return "کد واردشده درست نیست.";
  return "خطای غیرمنتظره. دوباره تلاش کنید.";
}

/** «۲ دقیقه دیگر» for a rate-limited resend. */
function retryAfterMessage(retryAfterMs: unknown): string {
  const ms = typeof retryAfterMs === "number" ? retryAfterMs : 0;
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) {
    return `درخواست بعدی تا ${toPersianDigits(String(seconds))} ثانیهٔ دیگر ممکن نیست.`;
  }
  return `درخواست بعدی تا ${toPersianDigits(String(Math.ceil(seconds / 60)))} دقیقهٔ دیگر ممکن نیست.`;
}

type Stage = "enrol_choose" | "enrol_sms_phone" | "enrol_show" | "challenge";

interface EnrolResponse {
  status?: string;
  method?: MfaMethod;
  totpSecret?: string;
  totpUrl?: string;
  totpQr?: string | null;
  phone?: string;
  recoveryCodes?: string[];
  error?: string;
}

export interface MfaStepProps {
  /** The five-minute `mfa_pending` token from the login response. */
  mfaToken: string;
  /** Which factor the account already holds, or null when it has none yet. */
  mfaMethod: MfaMethod | null;
  endpoints: MfaEndpoints;
  theme: MfaTheme;
  /** Called after `verify` has minted the real session cookie. */
  onVerified: () => void;
  /** Back to the email/password form — the token is discarded. */
  onCancel: () => void;
}

export function MfaStep({
  mfaToken,
  mfaMethod,
  endpoints,
  theme,
  onVerified,
  onCancel,
}: MfaStepProps) {
  const [stage, setStage] = useState<Stage>(
    mfaMethod ? "challenge" : "enrol_choose",
  );
  const [method, setMethod] = useState<MfaMethod | null>(mfaMethod);
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [enrolment, setEnrolment] = useState<EnrolResponse | null>(null);
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${mfaToken}`,
  };

  /**
   * Ask the server to start a challenge.
   *
   * A no-op for TOTP (the server answers `ready` — there is nothing to send),
   * an SMS for `sms_otp`. Every send costs money and the endpoint is rate
   * limited to one per minute, so this is never called speculatively: once when
   * the SMS step opens, and thereafter only when the user asks to resend.
   */
  const sendChallenge = useCallback(
    async (silent = false) => {
      setBusy(true);
      if (!silent) setError(null);
      try {
        const res = await fetch(endpoints.challenge, {
          method: "POST",
          headers: authHeaders,
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setError(
            retryAfterMessage(
              (data as { retryAfterMs?: unknown }).retryAfterMs,
            ),
          );
          return;
        }
        if (!res.ok) {
          setError(
            mfaErrorMessage(
              (data as { error?: string }).error,
              res.status,
              (data as { message?: string }).message,
            ),
          );
          return;
        }
        if ((data as { status?: string }).status === "sent") {
          const masked = (data as { maskedPhone?: string }).maskedPhone ?? null;
          setMaskedPhone(masked);
          setNotice(
            masked
              ? `کد یک‌بارمصرف به ${toPersianDigits(masked)} پیامک شد.`
              : "کد یک‌بارمصرف پیامک شد.",
          );
        }
      } catch {
        setError("ارتباط با سرور برقرار نشد.");
      } finally {
        setBusy(false);
      }
    },
    // `authHeaders` is rebuilt each render but only ever depends on mfaToken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoints.challenge, mfaToken],
  );

  // Kick off the SMS exactly once when an already-enrolled SMS account lands
  // here. A ref rather than a state flag so React 18's double-invoked effects
  // in development cannot send two messages (and bill for two).
  const challengeStarted = useRef(false);
  useEffect(() => {
    if (
      stage !== "challenge" ||
      method !== "sms_otp" ||
      challengeStarted.current
    )
      return;
    challengeStarted.current = true;
    void sendChallenge(true);
  }, [stage, method, sendChallenge]);

  async function submitEnrol(chosen: MfaMethod) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoints.enrol, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          method: chosen,
          phone: chosen === "sms_otp" ? phone : undefined,
        }),
      });
      const data: EnrolResponse = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(mfaErrorMessage(data.error, res.status));
        return;
      }
      setMethod(chosen);
      setEnrolment(data);
      setStage("enrol_show");
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    } finally {
      setBusy(false);
    }
  }

  async function submitVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(endpoints.verify, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          code: code.trim(),
          useRecoveryCode: recoveryMode,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          mfaErrorMessage((data as { error?: string }).error, res.status),
        );
        setCode("");
        return;
      }
      onVerified();
    } catch {
      setError("ارتباط با سرور برقرار نشد.");
    } finally {
      setBusy(false);
    }
  }

  if (stage === "enrol_choose") {
    return (
      <div className={theme.card}>
        <div>
          <h2 className={theme.heading}>ورود دومرحله‌ای را فعال کنید</h2>
          <p className={theme.muted}>
            برای این حساب هنوز روش دومرحله‌ای ثبت نشده و مهلت فعال‌سازی تمام شده
            است. یکی از دو روش زیر را انتخاب کنید.
          </p>
        </div>
        {error ? <p className={theme.error}>{error}</p> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => submitEnrol("totp")}
          className={theme.primaryButton}
        >
          برنامهٔ رمزساز (Google Authenticator)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setError(null);
            setStage("enrol_sms_phone");
          }}
          className={theme.secondaryButton}
        >
          پیامک یک‌بارمصرف
        </button>
        <p className={theme.muted}>
          روی نصب محلی و بدون اینترنت، برنامهٔ رمزساز تنها روشی است که همیشه کار
          می‌کند.
        </p>
        <div className="text-center">
          <button type="button" onClick={onCancel} className={theme.linkButton}>
            انصراف و بازگشت
          </button>
        </div>
      </div>
    );
  }

  if (stage === "enrol_sms_phone") {
    return (
      <form
        className={theme.card}
        onSubmit={(e) => {
          e.preventDefault();
          void submitEnrol("sms_otp");
        }}
      >
        <div>
          <h2 className={theme.heading}>شمارهٔ موبایل</h2>
          <p className={theme.muted}>
            کد یک‌بارمصرف هر بار به این شماره پیامک می‌شود.
          </p>
        </div>
        {error ? <p className={theme.error}>{error}</p> : null}
        <input
          dir="ltr"
          inputMode="tel"
          autoFocus
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="09121234567"
          className={theme.input}
        />
        <button type="submit" disabled={busy} className={theme.primaryButton}>
          {busy ? "در حال ثبت…" : "ثبت شماره"}
        </button>
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setStage("enrol_choose");
            }}
            className={theme.linkButton}
          >
            بازگشت
          </button>
        </div>
      </form>
    );
  }

  if (stage === "enrol_show") {
    return (
      <div className={theme.card}>
        <div>
          <h2 className={theme.heading}>
            {method === "totp"
              ? "برنامهٔ رمزساز را تنظیم کنید"
              : "شماره ثبت شد"}
          </h2>
          {method === "totp" ? (
            <p className={theme.muted}>
              این کد QR را در برنامهٔ رمزساز اسکن کنید. این تصویر فقط همین یک
              بار نمایش داده می‌شود.
            </p>
          ) : (
            <p className={theme.muted}>
              از این پس کد یک‌بارمصرف به{" "}
              {toPersianDigits(enrolment?.phone ?? "")} پیامک می‌شود.
            </p>
          )}
        </div>

        {method === "totp" && enrolment?.totpQr ? (
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrolment.totpQr}
              alt="کد QR ورود دومرحله‌ای"
              className="size-48 rounded-lg bg-white p-2"
            />
          </div>
        ) : null}

        {method === "totp" && enrolment?.totpSecret ? (
          <div>
            <p className={theme.muted}>یا این کد را دستی وارد کنید:</p>
            <p dir="ltr" className={theme.codeBlock}>
              {enrolment.totpSecret}
            </p>
          </div>
        ) : null}

        <RecoveryCodeSheet
          codes={enrolment?.recoveryCodes ?? []}
          theme={theme}
        />

        <button
          type="button"
          className={theme.primaryButton}
          onClick={() => {
            setError(null);
            setNotice(null);
            setCode("");
            setStage("challenge");
          }}
        >
          ذخیره کردم؛ ادامه
        </button>
      </div>
    );
  }

  // stage === "challenge"
  return (
    <form onSubmit={submitVerify} className={theme.card}>
      <div>
        <h2 className={theme.heading}>
          {recoveryMode ? "کد بازیابی" : "کد تأیید دومرحله‌ای"}
        </h2>
        <p className={theme.muted}>
          {recoveryMode
            ? "یکی از کدهای بازیابی که هنگام فعال‌سازی ذخیره کرده‌اید را وارد کنید. هر کد فقط یک بار کار می‌کند."
            : method === "sms_otp"
              ? maskedPhone
                ? `کد ۶ رقمی پیامک‌شده به ${toPersianDigits(maskedPhone)} را وارد کنید.`
                : "کد ۶ رقمی پیامک‌شده را وارد کنید."
              : "کد ۶ رقمی برنامهٔ رمزساز را وارد کنید."}
        </p>
      </div>

      {notice && !error ? <p className={theme.notice}>{notice}</p> : null}
      {error ? <p className={theme.error}>{error}</p> : null}

      <input
        dir="ltr"
        autoFocus
        autoComplete="one-time-code"
        inputMode={recoveryMode ? "text" : "numeric"}
        maxLength={recoveryMode ? 20 : 6}
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={recoveryMode ? "ABCDE-FGHJK" : "------"}
        className={theme.input}
      />

      <button
        type="submit"
        disabled={busy || code.trim().length === 0}
        className={theme.primaryButton}
      >
        {busy ? "در حال بررسی…" : "تأیید و ورود"}
      </button>

      {!recoveryMode && method === "sms_otp" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void sendChallenge()}
          className={theme.secondaryButton}
        >
          ارسال دوبارهٔ کد
        </button>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className={theme.linkButton}
          onClick={() => {
            setRecoveryMode((v) => !v);
            setCode("");
            setError(null);
          }}
        >
          {recoveryMode ? "بازگشت به کد تأیید" : "استفاده از کد بازیابی"}
        </button>
        <button type="button" onClick={onCancel} className={theme.linkButton}>
          انصراف
        </button>
      </div>
    </form>
  );
}

/**
 * The busy label every waiting button shares — text, not a spinner: the
 * dashboard's motion budget is skeletons for regions and words for actions.
 */
function Spinner() {
  return <span className="animate-pulse">لطفاً صبر کنید…</span>;
}

/**
 * The one and only showing of the ten recovery codes.
 *
 * Deliberately noisy — a bordered block, a copy button, an explicit warning —
 * because the entire value of these codes depends on somebody writing them
 * down in the thirty seconds they are on screen. Nothing stores the plaintext,
 * so a page reload really does lose them.
 */
export function RecoveryCodeSheet({
  codes,
  theme,
}: {
  codes: string[];
  theme: MfaTheme;
}) {
  const [copied, setCopied] = useState(false);
  if (codes.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className={theme.notice}>
        این ۱۰ کد بازیابی را چاپ کنید یا جای امنی بنویسید. اگر گوشی‌تان را از
        دست بدهید، تنها راه ورود همین‌هاست و دیگر نمایش داده نمی‌شوند.
      </p>
      <div dir="ltr" className={`grid grid-cols-2 gap-1 ${theme.codeBlock}`}>
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <button
        type="button"
        className={theme.secondaryButton}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          } catch {
            // Clipboard access can be refused (insecure context, permissions);
            // the codes are on screen either way, so this is a convenience.
            setCopied(false);
          }
        }}
      >
        {copied ? "کپی شد" : "کپی کدها"}
      </button>
    </div>
  );
}
