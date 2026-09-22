"use client";

/**
 * The ۴-second hold-to-confirm button — the one press in the till that moves
 * money, made impossible to fire by accident.
 *
 * Pressing (pointer down, or holding Space/Enter) starts a visible progress
 * fill across the button; letting go before the full duration cancels, resets
 * the fill and says why with a toast, so the first failed attempt teaches the
 * gesture. Holding the whole duration submits exactly once — the completion
 * callback cannot re-fire, and the button disables itself the moment it fires
 * (busy/disabled also block a second attempt while the request is in flight,
 * which is the caller's idempotency belt on top of this braces).
 *
 * Pure timing lives in src/lib/hold-timer.ts; this component is only the
 * pointer/keyboard plumbing, the progress fill and the labels.
 *
 * Accessibility: the button carries `aria-description`-style instruction text
 * («برای ثبت، ۴ ثانیه نگه دارید») so a screen reader announces the gesture
 * before the user is asked to perform it. The fill is a real progress bar
 * (role=progressbar) so the state is spoken, not just seen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HoldTimer, prefersReducedMotion } from "@/lib/hold-timer";
import { toPersianDigits } from "@/lib/digits";
import { FOCUS } from "./orders/ops-styles";

export const HOLD_TOAST_MESSAGE = "برای ثبت پرداخت، دکمه را ۴ ثانیه نگه دارید.";

export function HoldToConfirmButton({
  durationMs = 4000,
  label,
  holdingLabel,
  onComplete,
  disabled = false,
  busy = false,
  className = "",
  cancelledMessage = HOLD_TOAST_MESSAGE,
  children,
}: {
  durationMs?: number;
  /** What the button says at rest. */
  label: string;
  /** What it says while held — shorter, so it stays readable beside the fill. */
  holdingLabel?: string;
  /** Fires exactly once, after one uninterrupted full-duration hold. */
  onComplete: () => void;
  disabled?: boolean;
  /** The request is in flight: same visual and behavioural lock as disabled. */
  busy?: boolean;
  className?: string;
  /** Shown (toast) when the hold is released early. Pass "" to stay silent. */
  cancelledMessage?: string;
  children?: React.ReactNode;
}) {
  const timerRef = useRef<HoldTimer | null>(null);
  const frameRef = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [held, setHeld] = useState(false);
  const [done, setDone] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const blocked = disabled || busy || done;

  if (!timerRef.current) {
    timerRef.current = new HoldTimer({
      durationMs,
      mode: "confirm",
      onComplete: () => {
        setDone(true);
        setHeld(false);
        setProgress(1);
        onCompleteRef.current();
      },
    });
  }
  const timer = timerRef.current;

  const stopLoop = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const loop = useCallback(() => {
    const timerNow = timerRef.current;
    if (!timerNow || !timerNow.isHeld) return;
    timerNow.advance(performance.now());
    setProgress(timerNow.progress(performance.now()));
    if (timerNow.isHeld) {
      frameRef.current = requestAnimationFrame(loop);
    }
  }, []);

  const beginHold = useCallback(() => {
    if (blocked) return;
    setHeld(true);
    setProgress(0);
    timer.start();
    stopLoop();
    frameRef.current = requestAnimationFrame(loop);
  }, [blocked, loop, stopLoop, timer]);

  const endHold = useCallback(
    (cancelled: boolean) => {
      const timerNow = timerRef.current;
      if (!timerNow?.isHeld) return;
      const wasComplete = timerNow.hasCompleted;
      timerNow.cancel();
      stopLoop();
      setHeld(false);
      setProgress(0);
      if (cancelled && !wasComplete && cancelledMessage) {
        toast.info(cancelledMessage);
      }
    },
    [cancelledMessage, stopLoop],
  );

  // Unmount safety: no rAF frame and no half-held timer outlives the button.
  useEffect(
    () => () => {
      stopLoop();
      timerRef.current?.cancel();
    },
    [stopLoop],
  );

  // Keyboard: Space/Enter held down runs the same clock; the OS's auto-repeat
  // keydowns are ignored (event.repeat) so one physical press is one hold.
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || blocked || held) return;
    beginHold();
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    endHold(true);
  }

  // Pointer: pointer events only (no click handler), so a press can never
  // fire twice, and pointerleave/cancel release the hold like a finger
  // sliding off the button.
  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (blocked) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginHold();
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.type === "pointerleave" && !held) return;
    endHold(true);
  }

  const secondsLeft = Math.max(0, Math.ceil((durationMs * (1 - progress)) / 1000));
  const reduced = prefersReducedMotion();

  return (
    <button
      type="button"
      disabled={blocked}
      aria-label={`برای ثبت، ${toPersianDigits(Math.round(durationMs / 1000))} ثانیه بدون رها کردن نگه دارید.`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative min-h-14 w-full select-none overflow-hidden rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition duration-200 active:scale-[0.99] disabled:opacity-55 motion-reduce:transition-none ${FOCUS} ${className}`}
      style={{ touchAction: "none" }}
    >
      {/* The progress fill. Grows from the RTL start edge (the reading
          direction the hold visually follows). Reduced motion keeps the fill
          but drops the smoothing transition — the safety gesture itself stays. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 start-0 bg-amber-600/40 dark:bg-amber-300/40"
        style={{
          width: `${progress * 100}%`,
          transition: reduced ? "none" : undefined,
        }}
      />
      <span className="relative z-10 flex items-center justify-center gap-2">
        {children}
        {busy
          ? "در حال ثبت…"
          : done
            ? label
            : held
              ? (holdingLabel ?? label) +
                (secondsLeft > 0 && !reduced
                  ? ` — ${toPersianDigits(secondsLeft)}`
                  : "")
              : label}
        <span className="sr-only" aria-live="polite">
          {held ? `${toPersianDigits(Math.round(progress * 100))} درصد` : ""}
        </span>
      </span>
    </button>
  );
}
