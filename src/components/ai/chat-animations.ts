/**
 * GSAP motion vocabulary for the chat surfaces (Phase 36c redesign).
 *
 * Everything funnels through `reducedMotion()` so the whole assistant
 * degrades to instant, still UI for users who asked for it. All helpers are
 * imperative — components call them from useGSAP effects with a scope — and
 * every tween cleans up after itself (`clearProps`) so re-renders never
 * fight a stale transform.
 */
import gsap from "gsap";

export function reducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const EASE_OUT = "power3.out";
export const EASE_BACK = "back.out(1.5)";
export const EASE_ELASTIC = "elastic.out(1, 0.55)";

/** A chat bubble arriving: drift up, fade in, tiny settle-back scale. */
export function animateBubbleIn(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    { y: 18, opacity: 0, scale: 0.97, transformOrigin: "center bottom" },
    { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: EASE_BACK, clearProps: "all" },
  );
}

/** The floating window opening from its launcher corner. */
export function animatePanelIn(
  el: HTMLElement,
  opts: { fromBottomSheet: boolean },
): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    opts.fromBottomSheet
      ? { y: "100%" }
      : { y: 30, scale: 0.92, opacity: 0, transformOrigin: "bottom left" },
    {
      y: 0,
      scale: 1,
      opacity: 1,
      duration: opts.fromBottomSheet ? 0.42 : 0.5,
      ease: opts.fromBottomSheet ? EASE_OUT : EASE_BACK,
      clearProps: "all",
    },
  );
}

/** The floating window closing toward its launcher corner. */
export function animatePanelOut(
  el: HTMLElement,
  opts: { fromBottomSheet: boolean },
  onComplete: () => void,
): void {
  if (reducedMotion()) {
    onComplete();
    return;
  }
  gsap.to(el, {
    ...(opts.fromBottomSheet
      ? { y: "100%" }
      : { y: 24, scale: 0.94, opacity: 0, transformOrigin: "bottom left" }),
    duration: 0.24,
    ease: "power2.in",
    onComplete,
  });
}

/** A dimmer fading in behind the mobile bottom sheet. */
export function animateBackdropIn(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: EASE_OUT, clearProps: "opacity" });
}

export function animateBackdropOut(el: HTMLElement, onComplete?: () => void): void {
  if (reducedMotion()) {
    onComplete?.();
    return;
  }
  gsap.to(el, { opacity: 0, duration: 0.22, ease: "power2.in", onComplete });
}

/** Welcome hero: cards stagger up one after another. */
export function animateStaggerIn(parent: HTMLElement, selector: string): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    parent.querySelectorAll<HTMLElement>(selector),
    { y: 16, opacity: 0 },
    {
      y: 0,
      opacity: 1,
      duration: 0.5,
      ease: EASE_OUT,
      stagger: 0.07,
      clearProps: "all",
    },
  );
}

/** The three typing dots, breathing forever until the reply arrives. */
export function animateTypingDots(parent: HTMLElement): gsap.core.Tween | null {
  if (reducedMotion()) return null;
  return gsap.to(parent.querySelectorAll<HTMLElement>("[data-typing-dot]"), {
    y: -4,
    duration: 0.32,
    ease: "sine.inOut",
    stagger: { each: 0.16, repeat: -1, yoyo: true },
  });
}

/** A soft, endless float for the hero's gradient orbs. */
export function animateFloat(el: HTMLElement, drift: { x: number; y: number }, duration: number): void {
  if (reducedMotion()) return;
  gsap.to(el, {
    x: drift.x,
    y: drift.y,
    duration,
    ease: "sine.inOut",
    repeat: -1,
    yoyo: true,
  });
}

/** The launcher badge bumping when it gains a number. */
export function animateBadgeBump(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    { scale: 0.4, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.5, ease: EASE_ELASTIC, clearProps: "all" },
  );
}

/** The send button popping when a message becomes sendable. */
export function animateSendPulse(el: HTMLElement): void {
  if (reducedMotion()) return;
  gsap.fromTo(
    el,
    { scale: 0.85 },
    { scale: 1, duration: 0.35, ease: EASE_BACK, clearProps: "all" },
  );
}
