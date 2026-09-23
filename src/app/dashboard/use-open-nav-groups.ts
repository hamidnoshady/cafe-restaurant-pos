"use client";

/**
 * "Which collapsible nav groups did this device leave open?" — one hook, for
 * the three menus that ask it.
 *
 * The dashboard's flat sidebar, the Accounting sidebar and the Website sidebar
 * each carried their own copy: the same `localStorage` key pattern, the same
 * `JSON.parse` in a `try`, the same silent `catch`, the same
 * `{...current, [key]: !current[key]}` toggle that writes back. Three copies of
 * roughly twenty lines whose only real difference was the storage key — and the
 * copies had already diverged in the way that matters. Two of them tracked a
 * `restored` flag so the first paint (before `localStorage` has been read, and
 * on the server, where it does not exist) matches the markup React hydrates;
 * the Website one did not, so its groups could flip open on hydration.
 *
 * `restored` is the whole reason this is a hook and not a pair of functions:
 * reading storage during render would desynchronise server and client markup,
 * so the read happens in an effect and callers are told when it has landed.
 * Until then a caller falls back to its own default (usually "open the group
 * that holds the current page"), which is exactly what the server rendered.
 *
 * Failing to remember a preference is never failing to navigate: every storage
 * access is wrapped, because private mode, a full quota and a hand-edited value
 * are all things a browser does, and none of them should break a menu.
 */

import { useCallback, useEffect, useState } from "react";

export interface OpenNavGroups {
  /** The stored map. Empty until `restored` is true. */
  openGroups: Record<string, boolean>;
  /** Whether the stored value has been read — false on the server and first paint. */
  restored: boolean;
  /**
   * Flips one group and writes the whole map back.
   *
   * `currentlyOpen` is the state the member can *see*, which is not always the
   * stored one: a group with no stored choice is showing its fallback (the
   * ledger group opens itself when the current page is inside it). Toggling on
   * the stored value instead would read "undefined → true" and leave a
   * fallback-open group open when the member clicked to close it.
   */
  toggleGroup: (key: string, currentlyOpen: boolean) => void;
  /**
   * Whether a group should render open: the stored choice if there is one,
   * otherwise `fallback` (and always `fallback` before the read lands, so the
   * hydrated markup matches the server's).
   */
  isOpen: (key: string, fallback: boolean) => boolean;
}

export function useOpenNavGroups(storageKey: string): OpenNavGroups {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        // A hand-edited or corrupt value is a preference, not an error — and a
        // non-object here would make `openGroups[key]` throw on read.
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          setOpenGroups(parsed as Record<string, boolean>);
        }
      }
    } catch {
      // Unreadable storage simply means "no remembered choice".
    }
    setRestored(true);
  }, [storageKey]);

  const toggleGroup = useCallback(
    (key: string, currentlyOpen: boolean) => {
      setOpenGroups((current) => {
        const next = { ...current, [key]: !currentlyOpen };
        try {
          window.localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // A device that refuses storage keeps the choice for the session.
        }
        return next;
      });
    },
    [storageKey],
  );

  const isOpen = useCallback(
    (key: string, fallback: boolean) =>
      restored ? (openGroups[key] ?? fallback) : fallback,
    [openGroups, restored],
  );

  return { openGroups, restored, toggleGroup, isOpen };
}
