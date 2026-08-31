"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 20 Wave 6 — admin read-only view of the business's audit trail
 * (team.manage-gated, same permission as shift history's review tab —
 * reviewing every employee/session/device/shift security event is the same
 * kind of "act on this business's security state" concern). Every action
 * shown here was already being written to `audit_log` by earlier phases and
 * waves; this tab is the first thing that ever reads it back.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { auditActionLabel, auditEntityLabel, credentialKindLabel, type CredentialKind } from "@/lib/audit";
import { ErrorBox, api, errorMessage } from "../ui";
import { SectionCard } from "../page-chrome";

interface AuditEntry {
  id: number;
  actorName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  createdAt: string;
  credentialType: string | null;
  deviceLabel: string | null;
}

const ENTITY_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "همه" },
  { value: "employee", label: "کارمند" },
  { value: "team", label: "تیم" },
  { value: "device", label: "دستگاه" },
  { value: "shift", label: "شیفت" },
  { value: "location", label: "شعبه" },
  { value: "account", label: "حساب" },
];

function formatTime(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

function sessionDetail(entry: AuditEntry): string | null {
  if (entry.action !== "employee.session_created") return null;
  const kind: CredentialKind = entry.credentialType === "webauthn" ? "webauthn" : "pin";
  const parts = [`با ${credentialKindLabel(kind)}`];
  if (entry.deviceLabel) parts.push(`از دستگاه «${entry.deviceLabel}»`);
  return parts.join(" ");
}

export function AuditLogSettings() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [entity, setEntity] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async (filterEntity: string) => {
    const qs = filterEntity ? `?entity=${encodeURIComponent(filterEntity)}` : "";
    const { ok, data } = await api<{ entries: AuditEntry[]; error?: string }>(`/api/audit-log${qs}`);
    if (ok) {
      setEntries(data.entries);
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load(entity);
  }, [load, entity]);

  return (
    <div className="space-y-6">
      <SectionCard title="گزارش حسابرسی">
        <p className="mb-4 text-sm text-muted-foreground">
          رویدادهای امنیتی کسب‌وکار: ورود کارکنان، تغییر اعتبارنامه، ثبت/حذف دستگاه و شروع/پایان شیفت.
        </p>
        <ErrorBox>{error}</ErrorBox>

        <div className="mb-4 flex flex-wrap gap-2">
          {ENTITY_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setEntity(filter.value)}
              aria-pressed={entity === filter.value}
              className={
                "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors " +
                (entity === filter.value
                  ? "border-amber-200 bg-amber-100 text-amber-950"
                  : "border-stone-200/80 text-stone-600 hover:bg-stone-50")
              }
            >
              {filter.label}
            </button>
          ))}
        </div>

        {entries === null && <LoadingSkeleton rows={3} />}
        {entries !== null && entries.length === 0 && (
          <p className="text-sm text-muted-foreground">رویدادی ثبت نشده است.</p>
        )}
        {entries !== null && entries.length > 0 && (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-input px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{auditActionLabel(entry.action)}</p>
                  <p className="text-xs text-muted-foreground">{formatTime(entry.createdAt)}</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  {entry.actorName ?? "سیستم"}
                  {" · "}
                  {auditEntityLabel(entry.entity)}
                  {sessionDetail(entry) ? ` · ${sessionDetail(entry)}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
