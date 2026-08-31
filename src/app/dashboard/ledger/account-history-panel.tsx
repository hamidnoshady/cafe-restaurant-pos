"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { auditActionLabel } from "@/lib/audit";
import { api } from "../ui";
import { overlayPanelClass } from "../page-chrome";

interface HistoryEntry {
  id: number;
  actorName: string | null;
  action: string;
  createdAt: string;
  payload: { before?: string; after?: string } | null;
  accountBeforeParentLabel: string | null;
  accountAfterParentLabel: string | null;
}

function formatTime(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

/** What actually changed, for the one row types that carry a before/after. */
function changeDetail(entry: HistoryEntry): string | null {
  if (entry.action === "account.renamed" && entry.payload?.before && entry.payload?.after) {
    return `از «${entry.payload.before}» به «${entry.payload.after}»`;
  }
  if (entry.action === "account.reparented") {
    const before = entry.accountBeforeParentLabel ?? "بدون سرگروه";
    const after = entry.accountAfterParentLabel ?? "بدون سرگروه";
    return `از «${before}» به «${after}»`;
  }
  return null;
}

/**
 * One account's change history (issue #160 §7.5, Phase 22 Wave 11) — who
 * renamed/reparented/archived it, and when. Reached from the
 * chart-of-accounts tab, same "small modal per account" pattern as
 * AccountStatementPanel, but reading from the shared audit trail
 * (audit-service.ts) instead of the ledger.
 */
export function AccountHistoryPanel({
  accountId,
  accountCode,
  accountName,
  onClose,
}: {
  accountId: string;
  accountCode: string;
  accountName: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    setEntries(null);
    api<{ entries: HistoryEntry[] }>(`/api/ledger/accounts/${accountId}/history`).then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
    });
  }, [accountId]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-history-heading"
        className={`${overlayPanelClass} max-h-[88vh] w-full max-w-2xl overflow-y-auto p-4 sm:max-h-[80vh] sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تاریخچهٔ تغییرات حساب</p>
            <h3 id="account-history-heading" className="mt-1 text-lg font-bold">
              {accountCode} — {accountName}
            </h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground">
            بستن
          </button>
        </header>

        {entries === null ? (
          <LoadingSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-muted px-4 py-8 text-center text-sm text-muted-foreground">
            هیچ تغییری برای این حساب ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-border bg-muted p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{auditActionLabel(entry.action)}</p>
                  <p className="text-xs text-muted-foreground">{formatTime(entry.createdAt)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{entry.actorName ?? "سیستم"}</p>
                {changeDetail(entry) ? <p className="mt-2">{changeDetail(entry)}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
