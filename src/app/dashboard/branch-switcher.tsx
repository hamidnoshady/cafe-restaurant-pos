"use client";

/**
 * Phase 14 — the persistent branch control in the dashboard shell.
 *
 * Fetches the caller's active branch and switchable set from
 * /api/locations/active (every member has an active branch, from a PIN
 * cashier fixed to one to an owner roaming all of them). Renders nothing for
 * a single-branch business or a member restricted to one branch — the switch
 * would have exactly one option, which isn't a switch.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";

interface Branch {
  id: string;
  name: string;
}

interface ActiveResponse {
  active: Branch | null;
  locations: Branch[];
  canSwitch: boolean;
}

export function BranchSwitcher({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<ActiveResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/locations/active");
        if (!res.ok || cancelled) {
          if (!cancelled) setState({ active: null, locations: [], canSwitch: false });
          return;
        }
        setState(await res.json());
      } catch {
        if (!cancelled) setState({ active: null, locations: [], canSwitch: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === null) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="در حال بارگذاری شعبه فعال"
        className={compact ? "" : "mb-3"}
      >
        <Skeleton aria-hidden="true" className={compact ? "h-11 w-40 rounded-xl" : "h-12 w-full rounded-lg"} />
      </div>
    );
  }
  if (!state.canSwitch || !state.active) return null;

  async function switchTo(locationId: string) {
    if (locationId === state?.active?.id) return;
    setBusy(true);
    const res = await fetch("/api/auth/switch-location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId }),
    });
    setBusy(false);
    if (res.ok) {
      // Every scoped screen resolves its branch server-side per request, so a
      // full data refresh — not just local state — is what actually matters.
      router.refresh();
    }
  }

  return (
    <div className={compact ? "" : "mb-3"}>
      {!compact ? <label className="mb-1 block text-xs text-muted-foreground">شعبهٔ فعال</label> : null}
      <SearchableSelect
        className={compact ? "min-h-11 max-w-40 rounded-xl border border-stone-200/80 bg-white px-3 text-sm text-stone-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45" : "w-full rounded-md border bg-background px-2 py-1.5 text-sm"}
        value={state.active.id}
        disabled={busy}
        onChange={(value) => void switchTo(value)}
        ariaLabel="انتخاب شعبهٔ فعال"
        options={state.locations.map((location) => ({ value: location.id, label: location.name }))}
      />
    </div>
  );
}
