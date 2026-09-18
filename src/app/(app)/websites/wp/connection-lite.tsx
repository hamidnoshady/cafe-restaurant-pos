"use client";

/** Shared store picker for WP Manager sections. */
import { useId } from "react";
import { cardClass } from "@/app/dashboard/page-chrome";
import { cn } from "@/lib/utils";

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
  disabled = false,
  embedded = false,
  className,
}: {
  connections: ConnectionLite[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Omit the picker card when it already lives inside a toolbar/card. */
  embedded?: boolean;
  className?: string;
}) {
  const generatedId = useId();
  const id = `wp-connection-${generatedId.replaceAll(":", "")}`;

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3",
        !embedded && cardClass,
        !embedded && "p-4",
        embedded && "w-full md:w-auto md:flex-1",
        className,
      )}
    >
      <label className="shrink-0 text-sm font-medium text-foreground" htmlFor={id}>
        فروشگاه
      </label>
      <select
        id={id}
        className="h-10 w-full min-w-0 rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-teal-500 focus-visible:ring-2 focus-visible:ring-teal-400/30 disabled:cursor-not-allowed disabled:opacity-60 sm:min-w-[14rem] sm:flex-1"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {connections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name} ({connection.linkMode === "plugin" ? "افزونه" : "REST"})
          </option>
        ))}
      </select>
    </div>
  );
}
