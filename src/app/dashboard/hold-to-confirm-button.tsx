"use client";

/**
 * The ۴-second hold-to-confirm button — the one press in the till that moves
 * money, made impossible to fire by accident.
 *
 * Pressing (pointer down, or holding Space/Enter) starts a visible progress
 * fill across the whole button face; letting go before the full duration
 * cancels, resets the fill and says why with a toast, so the first failed
 * attempt teaches the gesture. Holding the whole duration submits exactly once
 * — the completion callback cannot re-fire, and the button disables itself the
 * moment it fires (busy/disabled also block a second attempt while the request
 * is in flight, which is the caller's idempotency belt on top of these braces).
 *
 * Pure timing lives in src/lib/hold-timer.ts and is read through **one clock**
 * (`timer.clock()`, monotonic) for the whole lifecycle — start, every frame,
 * and the progress read in that frame. Mixing `Date.now()` with
 * `performance.now()` was the timing bug this component was rebuilt around: it
 * made a hold either never complete or complete instantly.
 *
 * Accessibility: the button carries instruction text («برای ثبت، ۴ ثانیه نگه
 * دارید») so a screen reader announces the gesture before the user is asked to
 * perform it, and the fill is mirrored by an `aria-live` percentage. Keyboard
 * holds Space/Enter with the OS auto-repeat ignored.
 *
 * Haptics: a short buzz at the start, at each quarter milestone and at
 * completion, feature-detected through src/lib/haptics.ts — a device with no
 * Vibration API (every desktop, iOS Safari) is unaffected and keeps the
 * visual fill.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HoldTimer, prefersReducedMotion } from "@/lib/hold-timer";
import { HAPTIC, vibrate } from "@/lib/haptics";
import { toPersianDigits } from "@/lib/digits";
import { FOCUS } from "./orders/ops-styles";

export const HOLD_TOAST_MESSAGE = "برای ثبت پرداخت، دکمه را ۴ ثانیه نگه دارید.";

/** Buzz points along the hold, as a fraction of the total duration. */
const HAPTIC_MILESTONES = [0.25, 0.5, 0.75] as const;

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
  /** Which quarter milestones have already buzzed in this hold. */
  const milestoneRef = useRef(0);
  /** The pointer that owns the current hold — a second finger is ignored. */
  const pointerRef = useRef<number | null>(null);
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
        vibrate(HAPTIC.success);
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

  /**
   * One frame: read the clock **once**, advance on it, and paint the progress
   * from the same reading. Two reads of a moving clock in one frame is how the
   * fill and the completion drift apart.
   */
  const loop = useCallback(() => {
    const current = timerRef.current;
    if (!current || !current.isHeld) return;
    const now = current.clock();
    current.advance(now);
    if (!current.isHeld) return; // completed inside advance()
    const next = current.progress(now);
    setProgress(next);
    while (
      milestoneRef.current < HAPTIC_MILESTONES.length &&
      next >= HAPTIC_MILESTONES[milestoneRef.current]
    ) {
      milestoneRef.current += 1;
      vibrate(HAPTIC.milestone);
    }
    frameRef.current = requestAnimationFrame(loop);
  }, []);

  const beginHold = useCallback(() => {
    if (blocked) return;
    const current = timerRef.current;
    if (!current || current.isHeld) return;
    milestoneRef.current = 0;
    setHeld(true);
    setProgress(0);
    current.start();
    vibrate(HAPTIC.start);
    stopLoop();
    frameRef.current = requestAnimationFrame(loop);
  }, [blocked, loop, stopLoop]);

  const endHold = useCallback(
    (cancelled: boolean) => {
      const current = timerRef.current;
      pointerRef.current = null;
      if (!current?.isHeld) return;
      const wasComplete = current.hasCompleted;
      current.cancel();
      stopLoop();
      milestoneRef.current = 0;
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

  // A button that becomes disabled/busy mid-hold (the caller started the
  // request, or the order was paid on another device) drops the hold rather
  // than leaving a frozen fill and a live timer behind it.
  useEffect(() => {
    if (blocked && timerRef.current?.isHeld) endHold(false);
  }, [blocked, endHold]);

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

  // A focus lost mid-hold (tab away, a dialog stealing focus) is a release:
  // the keyup would otherwise never arrive and the fill would stick.
  function handleBlur() {
    endHold(true);
  }

  /*
    Pointer events only — no `onClick`. One pointer owns a hold (`pointerRef`),
    so a second finger, a stylus resting on the glass, or a mouse's synthesised
    "ghost" events cannot start a second timer or release someone else's.
    Capture keeps the pointer's own up/cancel coming to this element even if
    the finger slides off it.
  */
  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (blocked) return;
    if (pointerRef.current !== null) return;
    // Mouse: left button only — a right or middle press must not arm payment.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    pointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginHold();
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLButtonElement>) {
    if (pointerRef.current !== null && event.pointerId !== pointerRef.current) return;
    if (event.type === "pointerleave" && !held) return;
    endHold(true);
  }

  const secondsLeft = Math.max(0, Math.ceil((durationMs * (1 - progress)) / 1000));
  const reduced = prefersReducedMotion();
  const percent = Math.round(progress * 100);

  return (
    <button
      type="button"
      disabled={blocked}
      aria-label={`${label} — برای ثبت، ${toPersianDigits(Math.round(durationMs / 1000))} ثانیه بدون رها کردن نگه دارید.`}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={handleBlur}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative min-h-14 w-full select-none overflow-hidden rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition duration-200 active:scale-[0.99] disabled:opacity-55 motion-reduce:transition-none ${FOCUS} ${className}`}
      style={{ touchAction: "none" }}
    >
      {/*
        The progress fill — a solid sweep across the *whole* button face, not a
        hairline: the cashier must be able to read "how far am I" from across
        the counter. It grows from the RTL start edge (the reading direction
        the hold visually follows) in a deeper shade of the same design-system
        amber accent the button already is, so the label stays legible on both
        halves of the sweep. It is a real progressbar, so the state is spoken
        as well as seen. Reduced motion keeps the fill and drops only the
        smoothing.
      */}
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="پیشرفت نگه‌داشتن برای ثبت پرداخت"
        data-testid="hold-progress-fill"
        className="pointer-events-none absolute inset-y-0 start-0 bg-amber-600 dark:bg-amber-300"
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
                (secondsLeft > 0 && !reduced ? ` — ${toPersianDigits(secondsLeft)}` : "")
              : label}
        <span className="sr-only" aria-live="polite">
          {held ? `${toPersianDigits(percent)} درصد` : ""}
        </span>
      </span>
    </button>
  );
}
