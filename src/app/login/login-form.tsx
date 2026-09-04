"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import { Skeleton } from "@/components/ui/skeleton";
import {
  browserSupportsWebAuthn,
  startAuthentication,
} from "@simplewebauthn/browser";
import { PinPad } from "@/components/auth/pin-pad";
import {
  lockoutMessage,
  retryAfterMs,
  useNextPath,
} from "@/components/auth/login-helpers";

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
 *
 * Since the login split this page is the *staff* door only: name-then-PIN
 * (plus biometrics where registered). The owner/manager password login moved
 * to the tenant origin's `/admin` subdirectory (src/app/admin), so the till's
 * front screen no longer offers a password form — the business's origin simply
 * *is* the staff quick login.
 */
export default function LoginForm() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className={`w-full max-w-sm ${cardClass} p-8`}>
        <h1 className="mb-1 text-center text-xl font-bold">
          پلتفرم مدیریت کسب‌وکار
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">
          ورود سریع کارکنان
        </p>

        <PinLogin />
      </div>
    </main>
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
 * Why the staff list did not arrive. They are told apart because they read
 * completely differently to the person standing at the till, and because only
 * one of them is worth waiting out:
 *
 *  - `rate_limited` — a 429: the per-IP ceiling on this read is momentarily
 *    spent (every terminal in the building shares one address, and this page
 *    loads on every visit to the business's origin), which clears by itself
 *    in seconds.
 *  - `no_business` — the server could not say which business this origin
 *    belongs to (`unknown_business`/`business_required`). Nothing the cashier
 *    can retry their way out of: it is a deployment that has not been pointed
 *    at a tenant, so the message names that instead of blaming the roster,
 *    and carries the operator-facing hint in the same shape the unresolvable-
 *    host page uses.
 *  - `error` — anything else, which is a fault worth reporting as one.
 *
 * All three used to render the same dead-end sentence, which is why an origin
 * that simply had no business attached read as "your staff list is broken".
 */
type RosterFailure = "rate_limited" | "no_business" | "error";

const ROSTER_FAILURE_MESSAGES: Record<RosterFailure, string> = {
  rate_limited: "درخواست‌ها از حد مجاز گذشت؛ چند لحظه دیگر دوباره تلاش می‌کنیم.",
  no_business: "این نشانی به کسب‌وکاری وصل نیست؛ با پشتیبانی تماس بگیرید.",
  error: "دریافت فهرست کارکنان ممکن نشد.",
};

/** How many times a 429 is waited out before the retry button is all that is left. */
const MAX_ROSTER_RETRIES = 2;

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
  const [rosterFailure, setRosterFailure] = useState<RosterFailure | null>(null);
  /** Bumped by the retry button; the roster effect keys off it. */
  const [rosterReloadKey, setRosterReloadKey] = useState(0);
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
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function load(attempt: number) {
      const deviceToken = readDeviceToken();
      const url = deviceToken
        ? `/api/auth/pin-login/roster?deviceToken=${encodeURIComponent(deviceToken)}`
        : "/api/auth/pin-login/roster";

      let res: Response;
      try {
        res = await fetch(url);
      } catch {
        // Offline, or the server unreachable — the till's own message, not a
        // claim about who works here.
        if (!cancelled) setRosterFailure("error");
        return;
      }

      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {
          employees?: RosterEmployee[];
        } | null;
        if (cancelled) return;
        setRosterFailure(null);
        setEmployees(data?.employees ?? []);
        return;
      }

      if (res.status === 429 && attempt < MAX_ROSTER_RETRIES) {
        // Wait out the window the server named instead of parking the screen on
        // an error; a second tablet waking up is not a fault the cashier can
        // do anything about, and it clears on its own.
        if (!cancelled) setRosterFailure("rate_limited");
        timer = setTimeout(
          () => void load(attempt + 1),
          retryAfterMs(res.headers.get("Retry-After")),
        );
        return;
      }

      if (res.status === 429) {
        if (!cancelled) setRosterFailure("rate_limited");
        return;
      }

      // The 400 the login family answers when it cannot name a tenant for this
      // origin. Worth reading the body for: it is the difference between "the
      // roster call failed" and "this address serves no business", and only the
      // second one tells whoever deployed it what to change.
      const reason = (await res.json().catch(() => null)) as { error?: unknown } | null;
      const code = typeof reason?.error === "string" ? reason.error : "";
      if (!cancelled) {
        setRosterFailure(
          code === "unknown_business" || code === "business_required" ? "no_business" : "error",
        );
      }
    }

    void load(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [rosterReloadKey]);

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

  /** Re-asks for the roster from scratch — the button under a failed load. */
  function retryRoster() {
    setEmployees(null);
    setRosterFailure(null);
    setRosterReloadKey((key) => key + 1);
  }

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
        {rosterFailure && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-destructive">{ROSTER_FAILURE_MESSAGES[rosterFailure]}</p>
            {rosterFailure === "no_business" && (
              // Same shape as the unresolvable-host page (src/app/page.tsx):
              // the Persian line is for the person at the till, this one is for
              // whoever deployed the app, because they are the only one who can
              // fix it and they will not be reading the server log.
              <p className="text-start text-xs text-muted-foreground" dir="ltr">
                This origin resolves to no business. Set ROOT_DOMAIN (and
                TRUST_FORWARDED_HOST=on behind a platform that rewrites Host), or give
                the business a subdomain matching this hostname&rsquo;s first label;{" "}
                <code>/api/host/resolve?debug=1</code> shows what the app sees.
              </p>
            )}
            {/* The screen is the till's front door, so a failure here must never
                be a dead end: one tap re-asks, without reloading the page and
                losing the device token and recents that live beside it. */}
            <button
              type="button"
              onClick={retryRoster}
              className="rounded-lg border border-input px-4 py-2 text-sm font-semibold transition hover:bg-primary/10 outline-none focus-visible:ring focus-visible:ring-ring/50"
            >
              تلاش دوباره
            </button>
          </div>
        )}
        {!rosterFailure && !employees && (
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
        {!rosterFailure && employees && employees.length === 0 && (
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
