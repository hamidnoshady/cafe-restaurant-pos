"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 20 Wave 7 — the admin security center's first landing point
 * (team.manage-gated, same permission as shift history and the audit log):
 * every employee currently signed in, on which device, with a way to end a
 * session immediately; and the most recent failed PIN/biometric login
 * attempts, previously invisible to any admin view (Wave 6's third open
 * question). The full history of every security event — including these
 * same sessions' own creation/revocation — stays the audit log tab's job;
 * this tab is the actionable subset, not a replacement for it.
 *
 * Phase 20 Wave 8 — a third section, "کارمندان قفل‌شده": repeated failed
 * attempts (LOGIN_LOCKOUT_THRESHOLD within LOGIN_LOCKOUT_WINDOW_MINUTES, see
 * employee.ts's lockoutStatus) now automatically blocks further login
 * attempts for that employee, not just showing up in the list below — this
 * section is where an owner/manager sees who's currently locked and can end
 * it early instead of waiting out the window.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { credentialKindFromId, credentialKindLabel } from "@/lib/audit";
import { ErrorBox, InfoBox, api, errorMessage } from "../ui";
import { SectionCard } from "../page-chrome";
import { Button } from "@/components/ui/button";

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

interface LockedEmployee {
  employeeId: string;
  employeeName: string;
  failedCount: number;
  lockedUntil: string;
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
  const [lockedEmployees, setLockedEmployees] = useState<LockedEmployee[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [sessionsResult, attemptsResult, lockoutsResult] = await Promise.all([
      api<{ sessions: ActiveSession[]; error?: string }>("/api/sessions"),
      api<{ entries: FailedAttempt[]; error?: string }>(
        "/api/audit-log?action=employee.login_failed&limit=20",
      ),
      api<{ lockouts: LockedEmployee[]; error?: string }>("/api/security/lockouts"),
    ]);
    if (sessionsResult.ok) {
      setSessions(sessionsResult.data.sessions);
    } else {
      setError(errorMessage(sessionsResult.data.error));
    }
    if (attemptsResult.ok) {
      setFailedAttempts(attemptsResult.data.entries);
    }
    if (lockoutsResult.ok) {
      setLockedEmployees(lockoutsResult.data.lockouts);
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

  async function clearLockout(employeeId: string) {
    setBusyId(employeeId);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/security/lockouts/${employeeId}`, {
      method: "DELETE",
    });
    setBusyId(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("قفل ورود برداشته شد.");
    await load();
  }

  return (
    <div className="space-y-6">
      <SectionCard title="کارمندان قفل‌شده">
        <p className="mb-4 text-sm text-muted-foreground">
          به‌دلیل تلاش‌های ناموفق مکرر، ورود این کارکنان موقتاً مسدود شده است.
        </p>
        {lockedEmployees !== null && lockedEmployees.length === 0 && (
          <p className="text-sm text-muted-foreground">هیچ کارمندی قفل نیست.</p>
        )}
        {lockedEmployees !== null && lockedEmployees.length > 0 && (
          <div className="space-y-2">
            {lockedEmployees.map((entry) => (
              <div
                key={entry.employeeId}
                className="flex items-center justify-between rounded-lg border border-input px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{entry.employeeName}</p>
                  <p className="text-xs text-muted-foreground">
                    {toPersianDigits(String(entry.failedCount))} تلاش ناموفق پیاپی · تا{" "}
                    {formatTime(entry.lockedUntil)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => clearLockout(entry.employeeId)}
                  disabled={busyId === entry.employeeId}
                >
                  رفع قفل
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="نشست‌های فعال">
        <p className="mb-4 text-sm text-muted-foreground">
          کارکنانی که هم‌اکنون وارد سیستم هستند. پایان‌دادن به یک نشست بلافاصله اثر می‌کند.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {sessions === null && <LoadingSkeleton rows={3} />}
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => endSession(entry.id)}
                  disabled={busyId === entry.id}
                >
                  پایان نشست
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="تلاش‌های ورود ناموفق">
        <p className="mb-4 text-sm text-muted-foreground">
          آخرین پین‌های نادرست یا احرازهویت‌های بیومتریک ناموفق.
        </p>

        {failedAttempts === null && <LoadingSkeleton rows={3} />}
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
      </SectionCard>
    </div>
  );
}
