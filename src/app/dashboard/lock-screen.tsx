"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { LockIcon } from "lucide-react";
import { PinPad } from "@/components/auth/pin-pad";
import { overlayPanelClass } from "./page-chrome";
import { SIDEBAR_FOOTER_BUTTON_CLASS } from "./sidebar-nav-styles";

/**
 * Phase 20 Wave 2 — a client-side-only "step away from the till" convenience,
 * not a session boundary: the underlying `pos_session` cookie stays valid the
 * whole time, this just hides the screen behind a PIN prompt until the same
 * person (or anyone else who knows their PIN) re-enters it. Per-tab by
 * design (`sessionStorage`, not `localStorage`) so closing the terminal's
 * browser tab doesn't leave a stale "locked" flag for the next shift.
 */
const LOCK_KEY = "pos:locked";

const LockContext = createContext<(() => void) | null>(null);

export function useLockScreen(): () => void {
  const lock = useContext(LockContext);
  if (!lock) throw new Error("useLockScreen must be used within LockProvider");
  return lock;
}

export function LockProvider({
  fullName,
  children,
}: {
  fullName: string;
  children: React.ReactNode;
}) {
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    setLocked(window.sessionStorage.getItem(LOCK_KEY) === "1");
  }, []);

  function lock() {
    window.sessionStorage.setItem(LOCK_KEY, "1");
    setLocked(true);
  }

  function unlock() {
    window.sessionStorage.removeItem(LOCK_KEY);
    setLocked(false);
  }

  return (
    <LockContext.Provider value={lock}>
      {children}
      {locked && <LockOverlay fullName={fullName} onUnlock={unlock} />}
    </LockContext.Provider>
  );
}

function LockOverlay({ fullName, onUnlock }: { fullName: string; onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  async function submit(pin: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    setBusy(false);
    if (res.ok) {
      onUnlock();
    } else {
      setError("پین نادرست است.");
      setAttempt((a) => a + 1);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-xs p-6 text-center`}>
        <p className="mb-1 text-sm text-muted-foreground">صفحه قفل است</p>
        <p className="mb-4 font-semibold">{fullName}</p>
        <PinPad onComplete={submit} busy={busy} error={error} resetKey={attempt} />
      </div>
    </div>
  );
}

export function LockButton() {
  const lock = useLockScreen();
  return (
    <button type="button" onClick={lock} className={SIDEBAR_FOOTER_BUTTON_CLASS}>
      <LockIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-start">قفل صفحه</span>
    </button>
  );
}
