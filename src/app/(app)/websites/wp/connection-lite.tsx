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
  /**
   * True when the picker sits inside a toolbar that is already a card. The
   * default false keeps the standalone shape the store-section host uses;
   * true drops the card skin so the two never nest — a border inside a
   * border with double padding, which is what every section that wrapped
   * this in its own card used to render.
   */
  bare = false,
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  bare?: boolean;
}) {
  return (
    <div
      className={
        bare
          ? "flex min-w-[12rem] flex-1 flex-wrap items-center gap-2"
          : `${cardClass} flex flex-wrap items-center gap-3 p-4`
      }
    >
      {!bare ? (
        <label className="text-sm font-medium text-foreground" htmlFor="wp-connection-picker-shared">
          فروشگاه:
        </label>
      ) : null}
      <select
        id="wp-connection-picker-shared"
        aria-label="انتخاب فروشگاه"
        className="min-w-[12rem] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:border-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/30"
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
