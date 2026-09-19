"use client";

import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The console's detail drawer — a side sheet for inspecting one record (a bug
 * report, an audit event, a payment, a CMS site…) without leaving the list.
 * Large payloads (screenshots, attachments, JSON) load only when it opens
 * (section 32), because the drawer is what mounts them.
 */
export function PlatformDetailDrawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  side = "left",
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** RTL default: the drawer slides from the inline-start (visual left). */
  side?: "left" | "right";
  className?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        className={cn("flex w-full flex-col gap-0 p-0 sm:max-w-lg", className)}
      >
        <SheetHeader className="border-b border-border">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? <SheetFooter className="border-t border-border">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * A labelled key/value row for a detail drawer or panel — the console's
 * consistent way to display a field: label inline-start, value inline-end.
 */
export function PlatformDetailRow({
  label,
  children,
  className,
  dir,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  dir?: "ltr" | "rtl";
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 py-2 text-sm", className)}>
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-end text-foreground" dir={dir}>
        {children}
      </span>
    </div>
  );
}

/** A titled group of detail rows with a subtle divider between them. */
export function PlatformDetailSection({
  title,
  children,
  className,
}: {
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-4", className)}>
      {title ? (
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      ) : null}
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
