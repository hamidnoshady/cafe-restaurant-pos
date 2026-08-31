"use client";

import { CheckIcon, SparklesIcon } from "lucide-react";
import { ACTION_CATALOG, type ProposedAction } from "@/lib/ai";
import { Button } from "@/components/ui/button";

export function AiProposalCard({
  proposal,
  applied,
  applying,
  onApply,
  onDismiss,
}: {
  proposal: ProposedAction;
  applied?: boolean;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const meta = ACTION_CATALOG[proposal.type];
  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="mb-1 flex items-center gap-1.5 font-semibold text-primary">
        <SparklesIcon className="size-4" />
        {proposal.title || meta?.label}
      </div>
      {proposal.summary ? <p className="mb-2 text-foreground/90">{proposal.summary}</p> : null}
      <pre
        dir="ltr"
        className="mb-2 max-h-40 overflow-auto rounded-lg bg-background/70 p-2 text-left text-[11px] text-muted-foreground"
      >
        {JSON.stringify(proposal.payload, null, 2)}
      </pre>
      {applied ? (
        <p className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-4" /> ثبت شد
        </p>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" onClick={onApply} disabled={applying}>
            <CheckIcon aria-hidden="true" />
            {applying ? "در حال اجرا…" : "تأیید و اجرا"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss} disabled={applying}>
            رد
          </Button>
        </div>
      )}
    </div>
  );
}
