"use client";

/** Shared, responsive store picker for WP Manager sections. */
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
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  /**
   * Retained for compatibility with hosts that explicitly mark an already
   * embedded picker. The picker itself never owns card chrome; its host does.
   */
  embedded?: boolean;
}) {
  const id = useId();

  return (
    <div className="grid w-full min-w-0 gap-1.5 sm:w-auto sm:min-w-[20rem] sm:grid-cols-[auto_minmax(14rem,1fr)] sm:items-center sm:gap-3">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        فروشگاه
      </label>
      <select id={id} className={inputClass} value={value} onChange={(event) => onChange(event.target.value)}>
        {connections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name} ({connection.linkMode === "plugin" ? "افزونه" : "REST"})
          </option>
        ))}
      </select>
    </div>
  );
}
