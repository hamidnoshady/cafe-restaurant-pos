"use client";

/**
 * Phase 20 Wave 7 — the admin security center's first landing point
 * (team.manage-gated, same permission as shift history and the audit log):
 * every employee currently signed in, on which device, with a way to end a
 * session immediately; and the most recent failed PIN/biometric login
 * attempts, previously invisible to any admin view (Wave 6's third open
 * question). The full history of every security event — including these
 * same sessions' own creation/revocation — stays the audit log tab's job;
 * this tab is the actionable subset, not a replacement for it.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { credentialKindFromId, credentialKindLabel } from "@/lib/audit";
import { ErrorBox, InfoBox, api, errorMessage } from "../ui";

interface ActiveSession {
  id: string;
  employeeName: string;
  role: string;
  deviceLabel: string | null;
  credentialId: string | null;
  issuedAt: string;
  lastSeenAt: string | null;
}

interface FailedAttempt {
  id: number;
  entityName: string | null;
  createdAt: string;
  payload: unknown;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

function failureReason(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const reason = (payload as { reason?: unknown }).reason;
  if (reason === "invalid_pin") return "پین نادرست";
  if (reason === "invalid_assertion") return "احرازهویت بیومتریک ناموفق";
  if (reason === "employee_inactive") return "کارمند غیرفعال";
  return typeof reason === "string" ? reason : null;
}

export function SecurityCenterSettings() {
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const [failedAttempts, setFailedAttempts] = useState<FailedAttempt[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [sessionsResult, attemptsResult] = await Promise.all([
      api<{ sessions: ActiveSession[]; error?: string }>("/api/sessions"),
      api<{ entries: FailedAttempt[]; error?: string }>(
        "/api/audit-log?action=employee.login_failed&limit=20",
      ),
    ]);
    if (sessionsResult.ok) {
      setSessions(sessionsResult.data.sessions);
    } else {
      setError(errorMessage(sessionsResult.data.error));
    }
    if (attemptsResult.ok) {
      setFailedAttempts(attemptsResult.data.entries);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function endSession(id: string) {
    setBusyId(id);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/sessions/${id}`, { method: "DELETE" });
    setBusyId(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("نشست پایان یافت.");
    await load();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">نشست‌های فعال</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          کارکنانی که هم‌اکنون وارد سیستم هستند. پایان‌دادن به یک نشست بلافاصله اثر می‌کند.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {sessions === null && <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
        {sessions !== null && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">هیچ نشست فعالی وجود ندارد.</p>
        )}
        {sessions !== null && sessions.length > 0 && (
          <div className="space-y-2">
            {sessions.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-lg border border-input px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{entry.employeeName}</p>
                  <p className="text-xs text-muted-foreground">
                    {credentialKindLabel(credentialKindFromId(entry.credentialId))}
                    {entry.deviceLabel ? ` · ${entry.deviceLabel}` : ""}
                    {" · آخرین فعالیت: "}
                    {formatTime(entry.lastSeenAt ?? entry.issuedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => endSession(entry.id)}
                  disabled={busyId === entry.id}
                  className="shrink-0 text-xs text-destructive hover:underline disabled:opacity-50"
                >
                  پایان نشست
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">تلاش‌های ورود ناموفق</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          آخرین پین‌های نادرست یا احرازهویت‌های بیومتریک ناموفق.
        </p>

        {failedAttempts === null && <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
        {failedAttempts !== null && failedAttempts.length === 0 && (
          <p className="text-sm text-muted-foreground">تلاش ناموفقی ثبت نشده است.</p>
        )}
        {failedAttempts !== null && failedAttempts.length > 0 && (
          <div className="space-y-2">
            {failedAttempts.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-input px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{entry.entityName ?? "کارمند ناشناس"}</p>
                  <p className="text-xs text-muted-foreground">{formatTime(entry.createdAt)}</p>
                </div>
                <p className="text-xs text-muted-foreground">{failureReason(entry.payload) ?? "—"}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
