import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Shared form scaffolding for the console (section 27). A field always has a
 * label, may have a description, and surfaces a per-field validation error in a
 * consistent place. A section groups related fields under a heading. These are
 * layout primitives around the central Input/Select/Switch, not replacements.
 */
export function PlatformFormSection({
  title,
  description,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      {title || description ? (
        <div>
          {title ? <h3 className="text-sm font-semibold text-foreground">{title}</h3> : null}
          {description ? (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function PlatformField({
  label,
  htmlFor,
  description,
  error,
  required,
  hint,
  children,
  className,
}: {
  label?: React.ReactNode;
  htmlFor?: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  /** A trailing hint aligned with the label (e.g. a character count). */
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={htmlFor}>
            {label}
            {required ? <span className="text-destructive"> *</span> : null}
          </Label>
          {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
        </div>
      ) : null}
      {description ? <p className="text-xs leading-5 text-muted-foreground">{description}</p> : null}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A consistent row of form actions (submit + cancel), right-aligned. */
export function PlatformFormActions({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-end gap-2 pt-2", className)}>
      {children}
    </div>
  );
}
