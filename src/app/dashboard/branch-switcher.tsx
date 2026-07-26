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

interface Branch {
  id: string;
  name: string;
}

interface ActiveResponse {
  active: Branch | null;
  locations: Branch[];
  canSwitch: boolean;
}

export function BranchSwitcher() {
  const router = useRouter();
  const [state, setState] = useState<ActiveResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/locations/active");
      if (!res.ok || cancelled) return;
      setState(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state?.canSwitch || !state.active) return null;

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
    <div className="mb-3">
      <label className="mb-1 block text-xs text-muted-foreground">شعبهٔ فعال</label>
      <select
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        value={state.active.id}
        disabled={busy}
        onChange={(e) => void switchTo(e.target.value)}
      >
        {state.locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
          </option>
        ))}
      </select>
    </div>
  );
}
