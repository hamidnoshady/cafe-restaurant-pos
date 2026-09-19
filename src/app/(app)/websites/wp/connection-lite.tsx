"use client";

/** Shared store picker for WP Manager sections. */
import { cardClass } from "@/app/dashboard/page-chrome";

export interface ConnectionLite {
  id: string;
  name: string;
  linkMode: "rest_api" | "plugin";
  status?: string;
}

export function ConnectionPicker({
  connections,
  value,
  onChange,
  embedded = false,
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  /**
   * Drop the card chrome when the picker sits inside another surface (a
   * toolbar card with the section's actions). The default standalone form
   * keeps the chrome so hosts that render it on its own are unchanged.
   */
  embedded?: boolean;
}) {
  return (
    <div
      className={
        embedded
          ? "flex min-w-0 flex-1 flex-wrap items-center gap-2"
          : `${cardClass} flex flex-wrap items-center gap-3 p-4`
      }
    >
      <label className="text-sm font-medium text-foreground" htmlFor="wp-connection-picker-shared">
        فروشگاه:
      </label>
      <select
        id="wp-connection-picker-shared"
        className="min-w-0 flex-1 basis-40 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:border-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/30 sm:min-w-56"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.linkMode === "plugin" ? "افزونه" : "REST"})
          </option>
        ))}
      </select>
    </div>
  );
}
