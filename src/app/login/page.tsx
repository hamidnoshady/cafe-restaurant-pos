"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PinPad } from "@/components/auth/pin-pad";

type Mode = "password" | "pin";

const ROLE_LABELS: Record<string, string> = {
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("password");

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-card p-8 shadow-sm">
        <h1 className="mb-1 text-center text-xl font-bold">
          سیستم فروش کافه و رستوران
        </h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">ورود به سامانه</p>

        <div className="mb-6 grid grid-cols-2 rounded-lg bg-muted p-1 text-sm">
          <button
            type="button"
            onClick={() => setMode("password")}
            className={`rounded-md py-2 transition ${
              mode === "password" ? "bg-card font-semibold shadow-sm" : "text-muted-foreground"
            }`}
          >
            مدیر / مالک
          </button>
          <button
            type="button"
            onClick={() => setMode("pin")}
            className={`rounded-md py-2 transition ${
              mode === "pin" ? "bg-card font-semibold shadow-sm" : "text-muted-foreground"
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

function PasswordForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) {
      // Root routes owners/managers to the wizard until setup is complete.
      router.push("/");
      router.refresh();
    } else {
      setError("ایمیل یا رمز عبور نادرست است.");
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1 block text-sm text-muted-foreground">
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
        <label htmlFor="password" className="mb-1 block text-sm text-muted-foreground">
          رمز عبور
        </label>
        <input
          id="password"
          type="password"
          dir="ltr"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 focus:border-primary focus:outline-none"
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-primary py-2.5 font-semibold text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50"
      >
        {busy ? "در حال ورود…" : "ورود"}
      </button>
    </form>
  );
}

interface RosterEmployee {
  id: string;
  fullName: string;
  role: string;
  photoUrl: string | null;
}

/** Device-local "who signed in here recently" — never synced, just a UI shortcut. */
const RECENTS_KEY = "pos:lastEmployees";
const MAX_RECENTS = 5;

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(employeeId: string) {
  try {
    const next = [employeeId, ...readRecents().filter((id) => id !== employeeId)].slice(0, MAX_RECENTS);
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
  const [employees, setEmployees] = useState<RosterEmployee[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  const [selected, setSelected] = useState<RosterEmployee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/pin-login/roster")
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
      if (ra === -1 && rb === -1) return a.fullName.localeCompare(b.fullName, "fa");
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
      body: JSON.stringify({ pin, employeeId: selected.id }),
    });
    setBusy(false);
    if (res.ok) {
      rememberRecent(selected.id);
      router.push("/dashboard");
      router.refresh();
    } else {
      setError("پین نادرست است.");
    }
  }

  if (!selected) {
    return (
      <div>
        <p className="mb-3 text-center text-sm text-muted-foreground">نام خود را انتخاب کنید</p>
        {rosterError && (
          <p className="text-center text-sm text-destructive">دریافت فهرست کارکنان ممکن نشد.</p>
        )}
        {!rosterError && !employees && (
          <p className="text-center text-sm text-muted-foreground">در حال بارگذاری…</p>
        )}
        {!rosterError && employees && employees.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">کارمندی برای ورود سریع یافت نشد.</p>
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
              className="flex flex-col items-center gap-1.5 rounded-lg p-2 text-center transition hover:bg-primary/10 active:scale-95"
            >
              <EmployeeAvatar employee={employee} />
              <span className="line-clamp-1 text-xs font-semibold">{employee.fullName}</span>
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
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← کارمند دیگر
        </button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{selected.fullName}</span>
          <EmployeeAvatar employee={selected} size="sm" />
        </div>
      </div>
      <PinPad onComplete={submit} busy={busy} error={error} resetKey={selected.id} />
    </div>
  );
}

function EmployeeAvatar({ employee, size = "md" }: { employee: RosterEmployee; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "size-8 text-xs" : "size-14 text-lg";
  if (employee.photoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={employee.photoUrl} alt="" className={`${dims} rounded-full object-cover`} />;
  }
  const initials = employee.fullName.trim().slice(0, 1);
  return (
    <span className={`${dims} flex items-center justify-center rounded-full bg-primary/15 font-bold text-primary`}>
      {initials}
    </span>
  );
}
