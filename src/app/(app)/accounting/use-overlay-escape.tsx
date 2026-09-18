"use client";

import { useEffect } from "react";

/**
 * Close a hand-rolled overlay on Escape.
 *
 * The ledger's panels (statement, history, voucher, installment, edit-account)
 * are plain fixed-position `<section role="dialog" aria-modal="true">` elements
 * rather than the shadcn `<Dialog>` the cheques register uses, and they only
 * ever closed on a backdrop click or the «بستن» button. A dialog that ignores
 * Escape is a keyboard trap for anyone not using a mouse, and it is the one
 * behaviour every reader already expects from `aria-modal="true"`.
 *
 * Deliberately only the key: focus trapping and scroll locking belong to a real
 * dialog primitive, and half-implementing them here would be worse than the
 * plain panel these already are.
 */
export function useOverlayEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      // A floating layer above this panel — a Radix popover (SearchableSelect)
      // — handles its own Escape and marks the event `defaultPrevented`; Radix
      // never stops propagation, so without this check the panel underneath
      // closed with it: one press, two layers gone.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onClose]);
}
