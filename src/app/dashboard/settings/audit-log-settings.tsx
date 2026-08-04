"use client";

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
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
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
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">گزارش حسابرسی</h2>
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
              className={
                "rounded-lg px-3 py-1.5 text-xs " +
                (entity === filter.value
                  ? "bg-primary/10 font-semibold text-primary"
                  : "text-muted-foreground hover:bg-muted")
              }
            >
              {filter.label}
            </button>
          ))}
        </div>

        {entries === null && <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
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
      </section>
    </div>
  );
}
