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
import { formatPhoneDisplay } from "@/lib/phone";
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
  if (reason === "invalid_phone_otp") return "کد پیامکی ورود نادرست";
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
      <PhoneLoginCard />

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امنیت و دسترسی</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">کارمندان قفل‌شده</h2>
          </div>
        }
        description="به‌دلیل تلاش‌های ناموفق مکرر، ورود این کارکنان موقتاً مسدود شده است."
      >
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

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">نشست‌های فعال</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">نشست‌های فعال</h2>
          </div>
        }
        description="کارکنانی که هم‌اکنون وارد سیستم هستند. پایان‌دادن به یک نشست بلافاصله اثر می‌کند."
      >
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

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ممیزی ورود</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">تلاش‌های ورود ناموفق</h2>
          </div>
        }
        description="آخرین پین‌های نادرست یا احرازهویت‌های بیومتریک ناموفق."
      >
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

/**
 * Phase 42 — the phone-login card: the member's own number, and the
 * business's adoption window.
 *
 * Two halves, and both exist because a 14-day window only works if someone
 * can see it counting down and spend it: the top half is the signed-in
 * member setting and verifying *their own* number (the OTP proves
 * possession, which is why it lives here and not on the team screen), and
 * the bottom half is the owner's view of the whole door — the countdown, and
 * the list of members whose number is still missing or unproven, exactly the
 * list to work through before the date arrives.
 */
interface PhoneSelfState {
  phone: string | null;
  phoneState: "none" | "unverified" | "verified";
  otpWindowOpen: boolean;
  policy: { state: "off" | "grace" | "pending_sms" | "enforced"; daysLeft: number | null };
}

interface TeamPhoneMember {
  id: string;
  fullName: string;
  role: string;
  isActive: boolean;
  phone: string | null;
  phoneVerified: boolean;
}

function PhoneLoginCard() {
  const [state, setState] = useState<PhoneSelfState | null>(null);
  const [members, setMembers] = useState<TeamPhoneMember[] | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const [selfRes, teamRes] = await Promise.all([
      api<PhoneSelfState & { error?: string }>("/api/auth/phone/self"),
      // The security center is team.manage-gated like every tab it shares,
      // so the member list is readable from here; a 403 would mean the tab
      // was reached without it, in which case the self half still matters.
      api<{ members?: TeamPhoneMember[]; error?: string }>("/api/team"),
    ]);
    if (selfRes.ok) setState(selfRes.data);
    if (teamRes.ok) setMembers(teamRes.data.members ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ status?: string; maskedPhone?: string; error?: string; message?: string; retryAfterMs?: number }>(
      "/api/auth/phone/self",
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!ok) {
      const map: Record<string, string> = {
        invalid_phone: "شمارهٔ موبایل معتبر نیست.",
        phone_missing: "شماره‌ای برای ارسال کد ثبت نشده است.",
        invalid_code: "کد واردشده درست نیست.",
        sms_dispatch_failed: "ارسال پیامک ممکن نشد. کمی بعد دوباره تلاش کنید.",
        rate_limited: "درخواست‌های پیاپی مجاز نیست؛ کمی صبر کنید.",
        account_locked: "حساب شما موقتاً قفل شده است.",
      };
      setError(data.message ?? map[data.error ?? ""] ?? errorMessage(data.error));
      return null;
    }
    return data;
  }

  async function sendCode() {
    const target = phone.trim() || state?.phone || "";
    const data = await post({ action: "send", ...(phone.trim() ? { phone: phone.trim() } : {}) });
    if (data) {
      setCodeSentTo(data.maskedPhone ?? target);
      setNotice(`کد تأیید به ${toPersianDigits(data.maskedPhone ?? "")} پیامک شد.`);
    }
  }

  async function verifyCode() {
    const data = await post({
      action: "verify",
      code,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    });
    if (data) {
      setNotice("شمارهٔ موبایل تأیید شد. از این پس می‌توانید با همین شماره وارد شوید.");
      setPhone("");
      setCode("");
      setCodeSentTo(null);
      await load();
    }
  }

  const unverified = (members ?? []).filter((m) => m.isActive && !(m.phone && m.phoneVerified));

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امنیت و دسترسی</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">ورود با شمارهٔ موبایل</h2>
        </div>
      }
      description="هر عضو با شمارهٔ موبایل خود و یک کد پیامکی وارد می‌شود؛ رمز عددی تا ۷ روز بعد از هر تأیید کار می‌کند."
    >
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {state === null ? (
        <LoadingSkeleton rows={2} />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">شمارهٔ شما:</span>
            {state.phone ? (
              <>
                <span dir="ltr">{toPersianDigits(formatPhoneDisplay(state.phone))}</span>
                {state.phoneState === "verified" ? (
                  <span className="rounded-full bg-emerald-600/10 px-2.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                    تأییدشده
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-600/10 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                    تأییدنشده
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">ثبت نشده</span>
            )}
          </div>

          {!codeSentTo ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-52">
                <label className="mb-1 block text-sm text-muted-foreground" htmlFor="phone-self">
                  {state.phone ? "تغییر شماره (اختیاری)" : "شمارهٔ موبایل"}
                </label>
                <input
                  id="phone-self"
                  dir="ltr"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="09121234567"
                  className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
                />
              </div>
              <Button
                type="button"
                disabled={busy || (!phone.trim() && !(state.phone && state.phoneState !== "verified"))}
                onClick={() => void sendCode()}
              >
                {state.phone && state.phoneState !== "verified" ? "ارسال کد تأیید" : "تأیید / تغییر شماره"}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-36">
                <label className="mb-1 block text-sm text-muted-foreground" htmlFor="phone-self-code">
                  کد ۶ رقمی پیامک‌شده
                </label>
                <input
                  id="phone-self-code"
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="------"
                  className="w-full rounded-lg border border-input px-3 py-2 text-center tracking-[0.3em] focus:border-primary focus:outline-none"
                />
              </div>
              <Button type="button" disabled={busy || code.length !== 6} onClick={() => void verifyCode()}>
                تأیید کد
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setCodeSentTo(null);
                  setCode("");
                }}
              >
                تغییر شماره
              </Button>
            </div>
          )}

          {state.policy.state === "grace" && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <p className="font-semibold">
                ورود با کد پیامکی از این تاریخ برای همه الزامی می‌شود
                {state.policy.daysLeft !== null
                  ? ` — ${toPersianDigits(String(state.policy.daysLeft))} روز دیگر`
                  : ""}
              </p>
              <p className="mt-1 text-muted-foreground">
                تا آن زمان ورود با رمز عددی بدون تغییر می‌ماند؛ همین حالا شماره‌ها را ثبت و تأیید کنید.
              </p>
            </div>
          )}
          {state.policy.state === "pending_sms" && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
              تاریخ الزام رسیده اما سرویس پیامک (کاوه‌نگار) هنوز تنظیم نشده است؛ تا تنظیم آن، ورود با رمز عددی بدون تغییر می‌ماند.
            </div>
          )}
          {state.policy.state === "enforced" && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-muted-foreground">
              ورود با کد پیامکی فعال است؛ هر عضو هر ۷ روز یک‌بار با کد پیامکی وارد می‌شود.
            </div>
          )}

          {members !== null && state.policy.state !== "off" && (
            <div>
              <p className="mb-2 text-sm font-medium">
                اعضای بدون شمارهٔ تأییدشده ({toPersianDigits(String(unverified.length))})
              </p>
              {unverified.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  همهٔ اعضای فعال شمارهٔ تأییدشده دارند.
                </p>
              ) : (
                <ul className="divide-y divide-border/80 rounded-lg border border-input text-sm">
                  {unverified.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <span>
                        {m.fullName}
                        <span className="ms-2 text-xs text-muted-foreground">{m.role}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {m.phone ? "تأییدنشده" : "بدون شماره"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                شمارهٔ اعضا را از «تیم» ثبت کنید؛ هر عضو شماره‌اش را با یک کد پیامکی تأیید می‌کند.
              </p>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
