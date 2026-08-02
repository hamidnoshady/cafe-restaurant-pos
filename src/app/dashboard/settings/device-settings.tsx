"use client";

/**
 * Phase 20 Wave 4 — pairs *this* browser/terminal as a registered device and
 * lists/revokes every device paired for the business. Pairing is the only
 * place the plaintext token is ever shown — it's saved straight into
 * localStorage on this device (the same key src/app/login/page.tsx reads)
 * and never sent back to this page again. Unlike the server-sync token
 * above it, a device token is not itself a security boundary: it only
 * narrows which webauthn credentials the login picker offers on this
 * terminal (see docs/phases/Phase-20-Employee-Secure-Identity.md's Wave 4
 * section) — losing it just drops the terminal back to showing every
 * eligible employee's biometric option, the pre-Wave-4 behaviour.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";

/** Shared with src/app/login/page.tsx — must stay in sync. */
const DEVICE_TOKEN_KEY = "pos:deviceToken";

interface Device {
  id: string;
  locationId: string | null;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

function formatTime(iso: string | null): string {
  if (!iso) return "هرگز";
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

export function DeviceSettings() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pairedHere, setPairedHere] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ devices: Device[]; error?: string }>("/api/devices");
    if (ok) {
      setDevices(data.devices);
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    try {
      setPairedHere(Boolean(window.localStorage.getItem(DEVICE_TOKEN_KEY)));
    } catch {
      // localStorage can be unavailable (private mode, quota) — pairing still works, it just won't persist.
    }
  }, []);

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ token: string; error?: string }>("/api/devices", {
      method: "POST",
      body: JSON.stringify({ label }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    try {
      window.localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
      setPairedHere(true);
    } catch {
      setNotice("دستگاه ثبت شد، اما ذخیره‌سازی محلی این مرورگر در دسترس نیست.");
    }
    setLabel("");
    setNotice((prev) => prev || "این دستگاه با موفقیت ثبت شد.");
    await load();
  }

  async function revoke(id: string) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/devices/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("دستگاه حذف شد و نشست‌های باز آن پایان یافت.");
    await load();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">ثبت این دستگاه</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          ثبت یک پایانه (صندوق، تبلت) به سیستم اجازه می‌دهد دکمهٔ ورود بیومتریک را فقط برای کارکنانی نشان دهد که
          دستگاه احرازهویت‌شان را دقیقاً روی همین دستگاه ثبت کرده‌اند.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        {pairedHere ? <InfoBox>این مرورگر هم‌اکنون به‌عنوان یک دستگاه ثبت‌شده شناخته می‌شود.</InfoBox> : null}
        <form onSubmit={pair}>
          <Field label="نام دستگاه" hint="مثلاً «صندوق ۱» یا «تبلت گارسون»">
            <input
              className={inputClass}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="صندوق ۱"
              maxLength={80}
            />
          </Field>
          <PrimaryButton disabled={busy || !label.trim()}>
            {busy ? "در حال ثبت…" : "ثبت این دستگاه"}
          </PrimaryButton>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">دستگاه‌های ثبت‌شده</h2>
        {devices === null && <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>}
        {devices !== null && devices.length === 0 && (
          <p className="text-sm text-muted-foreground">هنوز دستگاهی ثبت نشده است.</p>
        )}
        {devices !== null && devices.length > 0 && (
          <div className="space-y-2">
            {devices.map((device) => (
              <div
                key={device.id}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                  device.revokedAt ? "border-border/60 opacity-60" : "border-input"
                }`}
              >
                <div>
                  <p className="font-medium">{device.label}</p>
                  <p className="text-xs text-muted-foreground">
                    آخرین استفاده: {formatTime(device.lastSeenAt)}
                    {device.revokedAt ? " · حذف‌شده" : ""}
                  </p>
                </div>
                {!device.revokedAt && (
                  <button
                    type="button"
                    onClick={() => revoke(device.id)}
                    disabled={busy}
                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                  >
                    حذف
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
