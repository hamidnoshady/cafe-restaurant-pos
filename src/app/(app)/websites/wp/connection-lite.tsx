"use client";

/**
 * Shared store picker for WP Manager sections.
 *
 * It renders the label and the select and *nothing else*: every caller
 * already places it inside its own toolbar card (`${cardClass} flex … p-4`),
 * so drawing a second card here nested one bordered, padded surface inside
 * another — a doubled border with 2rem of dead space around the select, on
 * every WP Manager screen at once. The card belongs to the toolbar that owns
 * the row, not to a control that is only ever a part of one.
 */
import { useId } from "react";
import { inputClass } from "@/app/dashboard/ui";

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
  disabled,
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  // A page can host two pickers (a section plus a dialog); a hardcoded id
  // would tie both labels to whichever select mounted first.
  const id = useId();
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-nowrap">
      <label className="shrink-0 text-sm font-medium text-foreground" htmlFor={id}>
        فروشگاه:
      </label>
      <select
        id={id}
        className={`${inputClass} w-full sm:w-auto sm:min-w-[16rem] sm:flex-1`}
        value={value}
        disabled={disabled || connections.length === 0}
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
