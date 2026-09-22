"use client";

/**
 * The ۲-second hold-to-repeat button — the add-on quantity gesture in the
 * modifier picker.
 *
 * Deliberately a *separate* primitive from HoldToConfirmButton (the ۴-second
 * payment hold): different durations, different semantics (repeat vs
 * one-shot), different failure modes. What they share — the clock, the
 * exactly-once discipline, the pointer/keyboard plumbing — lives in
 * src/lib/hold-timer.ts.
 *
 * Semantics here:
 *  * a quick tap runs `onPress` (the toggle),
 *  * holding runs `onRepeat` once per `intervalMs` (۲ ثانیه) with the
 *    progress fill showing the ramp toward the next increment,
 *  * releasing before the first interval fires nothing but the tap, so an
 *    accidental graze can never add a unit.
 *
 * The distinction between "a tap" and "a hold" is made by whether the timer
 * fired: no fires → tap, any fire → hold. That keeps the two paths mutually
 * exclusive by construction — there is no timing heuristic at the release
 * site that could double-fire.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HoldTimer, prefersReducedMotion } from "@/lib/hold-timer";

export function HoldRepeatButton({
  intervalMs = 2000,
  onPress,
  onRepeat,
  disabled = false,
  className = "",
  children,
  ariaLabel,
  ariaPressed,
}: {
  intervalMs?: number;
  /** Runs on a quick tap — before the first repeat interval elapses. */
  onPress: () => void;
  /** Runs once per full interval while held. */
  onRepeat: () => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
  ariaLabel?: string;
  ariaPressed?: boolean;
}) {
  const timerRef = useRef<HoldTimer | null>(null);
  const frameRef = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [held, setHeld] = useState(false);
  const pressRef = useRef(onPress);
  const repeatRef = useRef(onRepeat);
  pressRef.current = onPress;
  repeatRef.current = onRepeat;

  if (!timerRef.current) {
    timerRef.current = new HoldTimer({
      durationMs: intervalMs,
      mode: "repeat",
      fireOnStart: false,
      onComplete: () => repeatRef.current(),
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
    if (disabled) return;
    setHeld(true);
    setProgress(0);
    timer.start();
    stopLoop();
    frameRef.current = requestAnimationFrame(loop);
  }, [disabled, loop, stopLoop, timer]);

  const endHold = useCallback(() => {
    const timerNow = timerRef.current;
    if (!timerNow?.isHeld) return;
    const wasHold = timerNow.occurrenceCount > 0;
    timerNow.cancel();
    stopLoop();
    setHeld(false);
    setProgress(0);
    if (!wasHold) pressRef.current();
  }, [stopLoop]);

  useEffect(
    () => () => {
      stopLoop();
      timerRef.current?.cancel();
    },
    [stopLoop],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat || disabled || held) return;
    beginHold();
  }

  function handleKeyUp(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    endHold();
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginHold();
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse" && event.type === "pointerleave" && !held) return;
    endHold();
  }

  const reduced = prefersReducedMotion();

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative select-none overflow-hidden transition duration-150 active:scale-[0.97] disabled:opacity-45 motion-reduce:transition-none ${className}`}
      style={{ touchAction: "none" }}
    >
      {children}
      {/* The ramp toward the next increment — a hairline at the bottom edge,
          RTL-first. Reduced motion keeps the bar but drops the smoothing. */}
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-1 bg-current/50"
        style={{
          width: `${progress * 100}%`,
          insetInlineStart: 0,
          opacity: held && progress > 0 ? 1 : 0,
          transition: reduced ? "none" : undefined,
        }}
      />
    </button>
  );
}
