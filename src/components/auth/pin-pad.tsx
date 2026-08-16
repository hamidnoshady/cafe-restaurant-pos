"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";

/**
 * The 4-digit entry pad shared by the login screen's PIN step (Phase 20
 * Wave 2's employee picker) and the dashboard lock screen — one keypad, two
 * callers, so a tweak to either doesn't drift out of sync with the other.
 */
export function PinPad({
  onComplete,
  busy = false,
  error = null,
  resetKey,
}: {
  onComplete: (pin: string) => void;
  busy?: boolean;
  error?: string | null;
  /** Change this to force the entered digits to clear (e.g. switching employees). */
  resetKey?: unknown;
}) {
  const [pin, setPin] = useState("");

  useEffect(() => {
    setPin("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  function press(digit: string) {
    if (busy) return;
    const next = (pin + digit).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      onComplete(next);
      setPin("");
    }
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
          <PadButton
            key={d}
            label={toPersianDigits(d)}
            ariaLabel={toPersianDigits(d)}
            onClick={() => press(d)}
          />
        ))}
        <PadButton
          label="پاک"
          ariaLabel="پاک کردن همه"
          onClick={() => setPin("")}
          muted
        />
        <PadButton
          label={toPersianDigits("0")}
          ariaLabel={toPersianDigits("0")}
          onClick={() => press("0")}
        />
        <PadButton
          label="⌫"
          ariaLabel="پاک کردن یک رقم"
          onClick={() => setPin((p) => p.slice(0, -1))}
          muted
        />
      </div>
      {error && (
        <p className="mt-3 text-center text-sm text-destructive">{error}</p>
      )}
      {busy && (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          در حال بررسی…
        </p>
      )}
    </div>
  );
}

function PadButton({
  label,
  ariaLabel,
  onClick,
  muted = false,
}: {
  label: string;
  ariaLabel?: string;
  onClick: () => void;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`rounded-lg py-3 text-lg font-semibold transition outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-95 ${
        muted
          ? "bg-muted text-muted-foreground hover:bg-muted-foreground/20"
          : "bg-muted hover:bg-primary/10"
      }`}
    >
      {label}
    </button>
  );
}
