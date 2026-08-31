"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from "@simplewebauthn/browser";
import { PinPad } from "@/components/auth/pin-pad";
import {
  MfaStep,
  TENANT_MFA_THEME,
  type MfaMethod,
} from "@/components/auth/mfa-step";
import { toPersianDigits } from "@/lib/digits";

type Mode = "password" | "pin";

/** What `/api/auth/login` can answer with, beyond the plain success shape. */
interface LoginResponse {
  error?: string;
  lockedUntil?: string;
  mfaRequired?: boolean;
  mfaToken?: string;
  mfaMethod?: MfaMethod | null;
  mfaState?: "grace" | "required";
  graceUntil?: string | null;
  graceDaysLeft?: number | null;
}

const ROLE_LABELS: Record<string, string> = {
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

/**
 * The client half of the login page. Kept separate from the route so the
 * route itself can be a server component that resolves host aliases (Phase
 * 23): a visit to a renamed business's *old* host is forwarded to the current
 * host's login before this form ever renders, because a session minted on an
 * alias host can never stick.
 */
export default function LoginForm() {
  const [mode, setMode] = useState<Mode>("password");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-center text-xl font-bold">
          سیستم فروش کافه و رستوران
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          ورود به سامانه
        </p>

        <div className="mb-6 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("password")}
            className={`rounded-md py-2 transition outline-none focus-visible:ring focus-visible:ring-ring/50 ${
              mode === "password"
                ? "bg-card font-semibold shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            مدیر / مالک
          </button>
          <button
            type="button"
            onClick={() => setMode("pin")}
            className={`rounded-md py-2 transition outline-none focus-visible:ring focus-visible:ring-ring/50 ${
              mode === "pin"
                ? "bg-card font-semibold shadow-sm"
                : "text-muted-foreground"
            }`}
          >
            ورود سریع با پین
          </button>
        </div>

        {mode === "password" ? <PasswordForm /> : <PinLogin />}
      </div>
    </main>
  );
}

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
function useNextPath(fallback: string): string {
  const params = useSearchParams();
  const requested = params.get("next");
  return requested && requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : fallback;
}

function PasswordForm() {
  const router = useRouter();
  // Root routes owners/managers to the wizard until setup is complete, so it
  // stays the fallback rather than /dashboard.
  const next = useNextPath("/");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Phase 24 Wave 2 — the second-factor interstitial.
   *
   * `/api/auth/login` answers `{ mfaRequired: true, mfaToken, mfaState }` for
   * an account past its grace window instead of setting a session cookie. Until
   * now nothing in the UI read that, so the response looked to the user exactly
   * like a wrong password.
   */
  const [pending, setPending] = useState<{ token: string; method: MfaMethod | null } | null>(null);
  /**
   * The grace nag: `mfaState: "grace"` arrives *alongside* a real session, so
   * this is a prompt, not a gate — the user is already signed in and may
   * dismiss it. Persisted for the length of the visit only; the countdown comes
   * back on the next login, which is the point of a countdown.
   */
  const [graceNotice, setGraceNotice] = useState<{ daysLeft: number | null } | null>(null);

  function goNext() {
    router.push(next);
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data: LoginResponse = await res.json().catch(() => ({}));
    setBusy(false);

    // A locked account answers 423 with the time it unlocks. Reporting that as
    // "wrong email or password" — as this form did — sends the user off to
    // re-check a password that is perfectly correct, and to keep trying, which
    // is exactly what extends the lockout. `PinLogin` below has handled this
    // since Phase 20 Wave 8; this is the same handling for the password realm.
    if (res.status === 423) {
      setError(lockoutMessage(data.lockedUntil));
      return;
    }

    if (res.ok && data.mfaRequired && data.mfaToken) {
      setPending({ token: data.mfaToken, method: data.mfaMethod ?? null });
      return;
    }

    if (res.ok) {
      if (data.mfaState === "grace") {
        setGraceNotice({ daysLeft: data.graceDaysLeft ?? null });
        return;
      }
      goNext();
      return;
    }

    setError("ایمیل یا رمز عبور نادرست است.");
  }

  if (pending) {
    return (
      <MfaStep
        mfaToken={pending.token}
        mfaMethod={pending.method}
        theme={TENANT_MFA_THEME}
        endpoints={{
          challenge: "/api/auth/mfa/challenge",
          verify: "/api/auth/mfa/verify",
          enrol: "/api/auth/mfa/enrol",
        }}
        onVerified={goNext}
        onCancel={() => {
          setPending(null);
          setPassword("");
        }}
      />
    );
  }

  if (graceNotice) {
    return <GracePrompt daysLeft={graceNotice.daysLeft} onContinue={goNext} />;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-sm text-muted-foreground"
        >
          ایمیل
        </label>
        <input
          id="email"
          type="email"
          dir="ltr"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>
      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-sm text-muted-foreground"
        >
          رمز عبور
        </label>
        <input
          id="password"
          type="password"
          dir="ltr"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <Loader2Icon className="size-4 animate-spin" /> در حال ورود…
          </span>
        ) : (
          "ورود"
        )}
      </button>
    </form>
  );
}

/**
 * Phase 24 Wave 2 — the "set up 2FA, N days left" nag.
 *
 * Shown *after* a successful sign-in, never instead of one. The phase spec is
 * explicit that during the grace window login shows "an enrolment prompt with
 * a 'later' button and a visible countdown", and that the hard gate only
 * follows once the window closes — a business cannot be locked out of its own
 * till by a security feature it has not been given time to adopt.
 *
 * Enrolment itself lives in the dashboard rather than here: at this point the
 * session cookie is already set, so «همین حالا فعال می‌کنم» is a normal
 * authenticated navigation, not a second login step.
 */
function GracePrompt({ daysLeft, onContinue }: { daysLeft: number | null; onContinue: () => void }) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        <p className="mb-1 font-semibold">ورود دومرحله‌ای را فعال کنید</p>
        <p className="text-muted-foreground">
          {daysLeft === null
            ? "حساب مالک باید به‌زودی با ورود دومرحله‌ای محافظت شود."
            : daysLeft <= 0
              ? "مهلت فعال‌سازی ورود دومرحله‌ای امروز تمام می‌شود."
              : `${toPersianDigits(String(daysLeft))} روز تا اجباری‌شدن ورود دومرحله‌ای باقی مانده است.`}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          router.push("/dashboard/settings?tab=security-center");
          router.refresh();
        }}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        همین حالا فعال می‌کنم
      </button>
      <button
        type="button"
        onClick={onContinue}
        className="w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
      >
        بعداً
      </button>
    </div>
  );
}

interface RosterEmployee {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
  hasWebauthn: boolean;
}

/** Device-local "who signed in here recently" — never synced, just a UI shortcut. */
const RECENTS_KEY = "pos:lastEmployees";
const MAX_RECENTS = 5;

/**
 * Phase 20 Wave 4 — this terminal's paired-device token, if an owner/manager
 * ever registered it from Settings → دستگاه‌های ثبت‌شده
 * (src/app/dashboard/settings/device-settings.tsx, same localStorage key).
 * Absent on every terminal that was never paired — those keep exactly Wave
 * 3's unnarrowed behaviour, since every call below treats a missing/invalid
 * token as "no device" rather than an error.
 */
const DEVICE_TOKEN_KEY = "pos:deviceToken";

function readDeviceToken(): string | null {
  try {
    return window.localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Phase 20 Wave 8 — a picker-narrowed PIN or biometric login can now come
 * back 423 (`account_locked`) after LOGIN_LOCKOUT_THRESHOLD failed attempts
 * (employee.ts's lockoutStatus); this turns that into a message with a
 * concrete wait time instead of the generic "wrong PIN" text.
 */
function lockoutMessage(lockedUntil: unknown): string {
  const until = typeof lockedUntil === "string" ? new Date(lockedUntil) : null;
  if (!until || Number.isNaN(until.getTime())) {
    return "به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است.";
  }
  const minutes = Math.max(
    1,
    Math.ceil((until.getTime() - Date.now()) / 60_000),
  );
  return `به‌دلیل تلاش‌های ناموفق مکرر، ورود موقتاً قفل شده است؛ ${toPersianDigits(String(minutes))} دقیقه دیگر دوباره تلاش کنید.`;
}

function rememberRecent(employeeId: string) {
  try {
    const next = [
      employeeId,
      ...readRecents().filter((id) => id !== employeeId),
    ].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // localStorage can be unavailable (private mode, quota) — the shortcut is a nicety, not a requirement.
  }
}

/**
 * Phase 20 Wave 2 — name-then-PIN. Step 1 shows the eligible staff (photo,
 * name, role), most-recently-used-on-this-device first; step 2 is the PIN
 * pad for whichever name was picked.
 */
function PinLogin() {
  const router = useRouter();
  const next = useNextPath("/dashboard");
  const [employees, setEmployees] = useState<RosterEmployee[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [selected, setSelected] = useState<RosterEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [webauthnSupported, setWebauthnSupported] = useState(false);

  useEffect(() => {
    // Checked client-side only (guarded, not called during the server render)
    // so the initial HTML never claims support the browser doesn't have.
    setWebauthnSupported(browserSupportsWebAuthn());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const deviceToken = readDeviceToken();
    const url = deviceToken
      ? `/api/auth/pin-login/roster?deviceToken=${encodeURIComponent(deviceToken)}`
      : "/api/auth/pin-login/roster";
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: { employees: RosterEmployee[] }) => {
        if (!cancelled) setEmployees(data.employees ?? []);
      })
      .catch(() => {
        if (!cancelled) setRosterError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ordered = useMemo(() => {
    if (!employees) return [];
    const recents = readRecents();
    return [...employees].sort((a, b) => {
      const ra = recents.indexOf(a.id);
      const rb = recents.indexOf(b.id);
      if (ra === -1 && rb === -1)
        return a.fullName.localeCompare(b.fullName, "fa");
      if (ra === -1) return 1;
      if (rb === -1) return -1;
      return ra - rb;
    });
  }, [employees]);

  async function submit(pin: string) {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pin,
        employeeId: selected.id,
        deviceToken: readDeviceToken(),
      }),
    });
    setBusy(false);
    if (res.ok) {
      rememberRecent(selected.id);
      router.push(next);
      router.refresh();
      return;
    }
    if (res.status === 423) {
      const data = await res.json().catch(() => ({}));
      setError(lockoutMessage((data as { lockedUntil?: unknown }).lockedUntil));
      return;
    }
    setError("پین نادرست است.");
  }

  async function submitBiometric() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const deviceToken = readDeviceToken();
      const optionsRes = await fetch("/api/auth/webauthn/login/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: selected.id, deviceToken }),
      });
      if (!optionsRes.ok) throw new Error("no_credentials");
      const { options, challengeToken } = await optionsRes.json();

      const response = await startAuthentication({ optionsJSON: options });

      const verifyRes = await fetch("/api/auth/webauthn/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeId: selected.id,
          response,
          challengeToken,
          deviceToken,
        }),
      });
      if (verifyRes.status === 423) {
        const data = await verifyRes.json().catch(() => ({}));
        setError(
          lockoutMessage((data as { lockedUntil?: unknown }).lockedUntil),
        );
        return;
      }
      if (!verifyRes.ok) throw new Error("invalid_credentials");

      rememberRecent(selected.id);
      router.push(next);
      router.refresh();
    } catch {
      // Covers a failed verification as well as the user cancelling the
      // browser's own biometric prompt — either way, the PIN pad below is
      // always right there as a fallback, so this doesn't need to explain
      // which happened.
      setError("ورود بیومتریک ناموفق بود؛ از پین استفاده کنید.");
    } finally {
      setBusy(false);
    }
  }

  if (!selected) {
    return (
      <div>
        <p className="mb-3 text-center text-sm text-muted-foreground">
          نام خود را انتخاب کنید
        </p>
        {rosterError && (
          <p className="text-center text-sm text-destructive">
            دریافت فهرست کارکنان ممکن نشد.
          </p>
        )}
        {!rosterError && !employees && (
          <div
            className="grid grid-cols-3 gap-2"
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label="در حال بارگذاری فهرست کارکنان"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} aria-hidden="true" className="h-16 rounded-xl" />
            ))}
          </div>
        )}
        {!rosterError && employees && employees.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">
            کارمندی برای ورود سریع یافت نشد.
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          {ordered.map((employee) => (
            <button
              key={employee.id}
              type="button"
              onClick={() => {
                setSelected(employee);
                setError(null);
              }}
              className="flex flex-col items-center gap-1.5 rounded-lg p-2 text-center transition hover:bg-primary/10 active:scale-95 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              <EmployeeAvatar employee={employee} />
              <span className="line-clamp-1 text-xs font-semibold">
                {employee.fullName}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {ROLE_LABELS[employee.role] ?? employee.role}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setSelected(null);
            setError(null);
          }}
          className="rounded text-sm text-muted-foreground hover:text-foreground outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ← کارمند دیگر
        </button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{selected.fullName}</span>
          <EmployeeAvatar employee={selected} size="sm" />
        </div>
      </div>
      {selected.hasWebauthn && webauthnSupported && (
        <button
          type="button"
          onClick={submitBiometric}
          disabled={busy}
          className="mb-4 w-full rounded-lg border border-input py-2.5 text-sm font-semibold transition hover:bg-primary/10 disabled:opacity-50 outline-none focus-visible:ring focus-visible:ring-ring/50"
        >
          ورود با اثر انگشت یا چهره
        </button>
      )}
      <PinPad
        onComplete={submit}
        busy={busy}
        error={error}
        resetKey={selected.id}
      />
    </div>
  );
}

function EmployeeAvatar({
  employee,
  size = "md",
}: {
  employee: RosterEmployee;
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "size-8 text-xs" : "size-14 text-lg";
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    setPhotoLoaded(false);
    setPhotoFailed(false);
  }, [employee.photoUrl]);

  if (employee.photoUrl && !photoFailed) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <span className={`${dims} relative inline-block shrink-0 overflow-hidden rounded-full`}>
        {!photoLoaded ? <Skeleton aria-hidden="true" className="absolute inset-0 size-full rounded-full" /> : null}
        <img
          src={employee.photoUrl}
          alt=""
          onLoad={() => setPhotoLoaded(true)}
          onError={() => setPhotoFailed(true)}
          className={`size-full object-cover transition-opacity motion-reduce:transition-none ${photoLoaded ? "opacity-100" : "opacity-0"}`}
        />
      </span>
    );
  }
  const initials = employee.fullName.trim().slice(0, 1);
  return (
    <span
      className={`${dims} flex items-center justify-center rounded-full bg-primary/15 font-bold text-primary`}
    >
      {initials}
    </span>
  );
}
