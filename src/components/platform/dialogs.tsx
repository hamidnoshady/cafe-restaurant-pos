"use client";

import * as React from "react";
import { AlertTriangleIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PlatformInlineError } from "./states";

/**
 * The console's confirmation dialogs (sections 27 + 4). Never `window.confirm`.
 *
 *   - PlatformConfirmDialog: a plain "are you sure?" for reversible actions.
 *   - PlatformDangerDialog: irreversible/destructive actions — red framing, an
 *     explicit consequences list, and an optional typed-confirmation phrase the
 *     operator must reproduce before the action unlocks.
 */
export function PlatformConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "تأیید",
  cancelLabel = "انصراف",
  onConfirm,
  busy,
  error,
  variant = "default",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: React.ReactNode;
  variant?: "default" | "destructive";
}) {
  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {error ? <PlatformInlineError>{error}</PlatformInlineError> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant === "destructive" ? "destructive" : "default"} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformDangerDialog({
  open,
  onOpenChange,
  title,
  description,
  consequences,
  affected,
  confirmPhrase,
  confirmLabel = "انجام عملیات",
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Bullet list of what will happen / what cannot be undone. */
  consequences?: React.ReactNode[];
  /** Which business/system is affected (rendered prominently). */
  affected?: React.ReactNode;
  /** If set, the operator must type this exact phrase to unlock the action. */
  confirmPhrase?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  busy?: boolean;
  error?: React.ReactNode;
}) {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const locked = Boolean(confirmPhrase) && typed.trim() !== confirmPhrase;

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2 text-destructive">
            <AlertTriangleIcon className="size-5 shrink-0" aria-hidden="true" />
            <DialogTitle className="text-destructive">{title}</DialogTitle>
          </div>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        {affected ? (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">مورد هدف: </span>
            <span className="font-medium text-foreground">{affected}</span>
          </div>
        ) : null}

        {consequences && consequences.length > 0 ? (
          <ul className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-foreground">
            {consequences.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span aria-hidden="true" className="text-destructive">•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {confirmPhrase ? (
          <div className="space-y-1.5">
            <Label htmlFor="danger-confirm">
              برای ادامه، عبارت <span className="font-mono font-semibold" dir="ltr">{confirmPhrase}</span> را وارد کنید
            </Label>
            <Input
              id="danger-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              dir="ltr"
              autoComplete="off"
              disabled={busy}
              className={cn(locked && typed ? "border-destructive" : undefined)}
            />
          </div>
        ) : null}

        {error ? <PlatformInlineError>{error}</PlatformInlineError> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            انصراف
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy || locked}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
