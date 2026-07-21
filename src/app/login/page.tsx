"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toPersianDigits } from "@/lib/digits";

type Mode = "password" | "pin";

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

        {mode === "password" ? <PasswordForm /> : <PinPad />}
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

function PinPad() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(fullPin: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/pin-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: fullPin }),
    });
    setBusy(false);
    setPin("");
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    } else {
      setError("پین نادرست است.");
    }
  }

  function press(digit: string) {
    if (busy) return;
    const next = (pin + digit).slice(0, 4);
    setPin(next);
    if (next.length === 4) void submit(next);
  }

  return (
    <div>
      <div className="mb-4 flex justify-center gap-3" aria-label="پین وارد شده">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`size-3.5 rounded-full ${i < pin.length ? "bg-primary" : "bg-muted"}`}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <PadButton key={d} label={toPersianDigits(d)} onClick={() => press(d)} />
        ))}
        <PadButton label="پاک" onClick={() => setPin("")} muted />
        <PadButton label={toPersianDigits("0")} onClick={() => press("0")} />
        <PadButton
          label="⌫"
          onClick={() => setPin((p) => p.slice(0, -1))}
          muted
        />
      </div>
      {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}
      {busy && <p className="mt-3 text-center text-sm text-muted-foreground">در حال ورود…</p>}
    </div>
  );
}

function PadButton({
  label,
  onClick,
  muted = false,
}: {
  label: string;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg py-3 text-lg font-semibold transition active:scale-95 ${
        muted ? "bg-muted text-muted-foreground hover:bg-muted-foreground/20" : "bg-muted hover:bg-primary/10"
      }`}
    >
      {label}
    </button>
  );
}
