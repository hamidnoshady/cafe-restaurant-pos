"use client";

/**
 * Registered terminals are an optional narrowing for the public biometric
 * login picker, not an authentication factor on their own. This screen is the
 * manager-facing lifecycle for that local browser identity: register, inspect
 * its branch/activity, rename it, and revoke it when the terminal is retired.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarPlusIcon, Clock3Icon, MapPinIcon, PencilIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  canStoreDeviceToken,
  clearDeviceToken,
  DEVICE_TOKEN_HEADER,
  readDeviceToken,
  storeDeviceToken,
} from "@/lib/device-token";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Device {
  id: string;
  locationId: string | null;
  locationName: string | null;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  activeSessionCount: number;
}

interface DevicesResponse {
  devices: Device[];
  /** The active row represented by this browser's locally stored token, if any. */
  currentDeviceId: string | null;
  error?: string;
}

interface PairResponse {
  token?: string;
  device?: Pick<Device, "id">;
  error?: string;
}

function formatMoment(iso: string | null): string {
  if (!iso) return "هرگز";
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

function branchLabel(device: Device): string {
  return device.locationName ?? "همهٔ شعب";
}

function sessionLabel(count: number): string {
  return count > 0 ? `${toPersianDigits(String(count))} نشست فعال` : "نشست فعالی ندارد";
}

function deviceHeaders(): HeadersInit | undefined {
  const token = readDeviceToken();
  return token ? { [DEVICE_TOKEN_HEADER]: token } : undefined;
}

export function DeviceSettings() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [label, setLabel] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isPairing, setIsPairing] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [editingDevice, setEditingDevice] = useState<Device | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [pendingRevoke, setPendingRevoke] = useState<Device | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { ok, data } = await api<DevicesResponse>("/api/devices", {
        headers: deviceHeaders(),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return false;
      }
      setDevices(data.devices);
      setCurrentDeviceId(data.currentDeviceId ?? null);
      setHasStoredToken(Boolean(readDeviceToken()));
      setError("");
      return true;
    } catch {
      setError("دریافت فهرست دستگاه‌ها ممکن نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.");
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setHasStoredToken(Boolean(readDeviceToken()));
    void load();
  }, [load]);

  const currentDevice = useMemo(
    () => devices?.find((device) => device.id === currentDeviceId && !device.revokedAt) ?? null,
    [currentDeviceId, devices],
  );
  const activeDevices = useMemo(() => (devices ?? []).filter((device) => !device.revokedAt), [devices]);
  const revokedDevices = useMemo(() => (devices ?? []).filter((device) => device.revokedAt), [devices]);

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    if (!canStoreDeviceToken()) {
      setError("مرورگر اجازهٔ ذخیرهٔ اطلاعات این دستگاه را نمی‌دهد. برای ثبت دستگاه، ذخیره‌سازی محلی مرورگر را فعال کنید.");
      return;
    }

    setIsPairing(true);
    setError("");
    setNotice("");
    try {
      const { ok, data } = await api<PairResponse>("/api/devices", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...deviceHeaders(),
        },
        body: JSON.stringify({ label }),
      });
      if (!ok || !data.token || !data.device?.id) {
        setError(errorMessage(data.error));
        return;
      }

      // The preflight above avoids an orphaned server row in normal use. Keep
      // the second check for a race with a browser privacy setting or quota
      // change, and revoke the just-created row if it happens.
      if (!storeDeviceToken(data.token)) {
        const rollback = await api<{ error?: string }>(`/api/devices/${data.device.id}`, { method: "DELETE" });
        await load();
        setError(
          rollback.ok
            ? "ثبت دستگاه لغو شد، چون مرورگر نتوانست شناسهٔ آن را ذخیره کند. ذخیره‌سازی محلی را فعال و دوباره تلاش کنید."
            : "دستگاه ثبت شد، اما مرورگر نتوانست شناسهٔ آن را ذخیره کند. برای جلوگیری از ثبت تکراری، ثبت این دستگاه را از فهرست لغو کنید.",
        );
        return;
      }

      setLabel("");
      setHasStoredToken(true);
      setCurrentDeviceId(data.device.id);
      setNotice("این دستگاه با موفقیت ثبت شد و ورود بیومتریک آن به همین مرورگر محدود می‌شود.");
      await load();
    } catch {
      setError("ثبت دستگاه ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setIsPairing(false);
    }
  }

  function startEditing(device: Device) {
    setError("");
    setNotice("");
    setEditingDevice(device);
    setEditingLabel(device.label);
  }

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!editingDevice) return;

    setRenamingId(editingDevice.id);
    setError("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/devices/${editingDevice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ label: editingLabel }),
      });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setEditingDevice(null);
      setNotice("نام دستگاه به‌روزرسانی شد.");
      await load();
    } catch {
      setError("ویرایش نام دستگاه ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setRenamingId(null);
    }
  }

  async function revoke() {
    if (!pendingRevoke) return;
    const device = pendingRevoke;
    setRevokingId(device.id);
    setError("");
    setNotice("");
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/devices/${device.id}`, { method: "DELETE" });
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }

      if (currentDeviceId === device.id) {
        clearDeviceToken();
        setHasStoredToken(false);
        setCurrentDeviceId(null);
      }
      setPendingRevoke(null);
      setNotice(
        currentDeviceId === device.id
          ? "ثبت این مرورگر لغو شد و شناسهٔ محلی آن پاک شد."
          : "ثبت دستگاه لغو شد و نشست‌های فعال آن پایان یافت.",
      );
      await load();
    } catch {
      setError("لغو ثبت دستگاه ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setRevokingId(null);
    }
  }

  const listUnavailable = devices === null && !isLoading;

  return (
    <div className="space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title={currentDevice ? "این دستگاه ثبت شده است" : "ثبت این دستگاه"}
        description={
          currentDevice
            ? "این مرورگر هنگام ورود، فقط اعتبارنامه‌های بیومتریک مرتبط با همین پایانه را در اولویت می‌گذارد."
            : "پایانه‌ای مانند صندوق یا تبلت را از همان مرورگری که روی آن استفاده می‌شود ثبت کنید."
        }
      >
        {devices === null && isLoading ? (
          <LoadingSkeleton rows={2} compact label="در حال بررسی ثبت این دستگاه" />
        ) : currentDevice ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold text-foreground">{currentDevice.label}</p>
              <StatusBadge tone="positive">همین دستگاه</StatusBadge>
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              برای ثبت پایانهٔ دیگر، تنظیمات را در مرورگر همان پایانه باز کنید. برای تغییر نام یا لغو ثبت، از فهرست پایین استفاده کنید.
            </p>
          </div>
        ) : (
          <>
            {hasStoredToken && !isLoading ? (
              <InfoBox>
                شناسهٔ ذخیره‌شدهٔ این مرورگر دیگر به یک دستگاه فعال وصل نیست. ثبت جدید، شناسهٔ محلی قبلی را جایگزین می‌کند.
              </InfoBox>
            ) : null}
            <form className="space-y-4" onSubmit={pair}>
              <Field label="نام دستگاه" hint="مثلاً «صندوق ۱» یا «تبلت گارسون»؛ نامی انتخاب کنید که در فهرست قابل تشخیص باشد.">
                <input
                  className={inputClass}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="صندوق ۱"
                  maxLength={80}
                  required
                  autoComplete="off"
                  disabled={isPairing}
                />
              </Field>
              <PrimaryButton disabled={isPairing || !label.trim()}>
                {isPairing ? "در حال ثبت…" : "ثبت این دستگاه"}
              </PrimaryButton>
            </form>
          </>
        )}
      </SectionCard>

      <SectionCard
        title="دستگاه‌های ثبت‌شده"
        description="پایانه‌های فعال همهٔ شعب را بررسی و در صورت نیاز نام آن‌ها را ویرایش یا ثبتشان را لغو کنید."
        actions={
          devices !== null ? (
            <StatusBadge tone={activeDevices.length > 0 ? "positive" : "neutral"}>
              {toPersianDigits(String(activeDevices.length))} فعال
            </StatusBadge>
          ) : null
        }
        flush
      >
        {devices === null && isLoading ? <LoadingSkeleton rows={3} className="p-4 sm:p-5" /> : null}
        {listUnavailable ? (
          <div className="p-4 text-center sm:p-5">
            <p className="text-sm text-muted-foreground">فهرست دستگاه‌ها در دسترس نیست.</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => void load()}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}
        {devices !== null && activeDevices.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز دستگاه فعالی ثبت نشده است. برای فعال‌کردن ورود بیومتریک اختصاصی، همین پایانه را ثبت کنید.</EmptyState>
          </div>
        ) : null}
        {activeDevices.length > 0 ? (
          <ul className="divide-y divide-border/80">
            {activeDevices.map((device) => (
              <li key={device.id} className="flex flex-col gap-4 px-4 py-4 sm:px-5 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 break-words font-semibold text-foreground">{device.label}</p>
                    {currentDeviceId === device.id ? <StatusBadge tone="positive">همین دستگاه</StatusBadge> : null}
                    {device.activeSessionCount > 0 ? <StatusBadge tone="active">{sessionLabel(device.activeSessionCount)}</StatusBadge> : null}
                  </div>
                  <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-xs text-muted-foreground sm:grid-cols-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <MapPinIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <dt className="shrink-0">شعبه:</dt>
                      <dd className="truncate" title={branchLabel(device)}>{branchLabel(device)}</dd>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <CalendarPlusIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <dt className="shrink-0">ثبت:</dt>
                      <dd>{formatMoment(device.pairedAt)}</dd>
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                      <Clock3Icon aria-hidden="true" className="size-3.5 shrink-0" />
                      <dt className="shrink-0">آخرین استفاده:</dt>
                      <dd>{formatMoment(device.lastSeenAt)}</dd>
                      {device.activeSessionCount === 0 ? (
                        <span className="me-1 text-muted-foreground">· {sessionLabel(device.activeSessionCount)}</span>
                      ) : null}
                    </div>
                  </dl>
                </div>
                <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={() => startEditing(device)}>
                    <PencilIcon aria-hidden="true" />
                    ویرایش نام
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setError("");
                      setNotice("");
                      setPendingRevoke(device);
                    }}
                    disabled={revokingId === device.id}
                  >
                    لغو ثبت
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        {revokedDevices.length > 0 ? (
          <details className="border-t border-border/80">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-5">
              سابقهٔ دستگاه‌های لغوشده ({toPersianDigits(String(revokedDevices.length))})
            </summary>
            <ul className="divide-y divide-border/80 border-t border-border/80">
              {revokedDevices.map((device) => (
                <li key={device.id} className="px-4 py-3 text-sm opacity-70 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{device.label}</p>
                    <StatusBadge tone="neutral">ثبت لغوشده</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {branchLabel(device)} · ثبت: {formatMoment(device.pairedAt)} · لغو: {formatMoment(device.revokedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </SectionCard>

      <Dialog
        open={Boolean(editingDevice)}
        onOpenChange={(open) => {
          if (!open && !renamingId) setEditingDevice(null);
        }}
      >
        <DialogContent showCloseButton={!renamingId}>
          <DialogHeader>
            <DialogTitle>ویرایش نام دستگاه</DialogTitle>
            <DialogDescription>
              تغییر نام فقط برای تشخیص بهتر پایانه در فهرست است؛ ورودهای بیومتریک و نشست‌های آن تغییر نمی‌کنند.
            </DialogDescription>
          </DialogHeader>
          <ErrorBox>{editingDevice ? error : ""}</ErrorBox>
          <form onSubmit={rename}>
            <Field label="نام دستگاه">
              <input
                className={inputClass}
                value={editingLabel}
                onChange={(event) => setEditingLabel(event.target.value)}
                maxLength={80}
                required
                autoFocus
                disabled={Boolean(renamingId)}
              />
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingDevice(null)}
                disabled={Boolean(renamingId)}
              >
                انصراف
              </Button>
              <Button type="submit" disabled={Boolean(renamingId) || !editingLabel.trim()}>
                {renamingId ? "در حال ذخیره…" : "ذخیرهٔ نام"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingRevoke)}
        onOpenChange={(open) => {
          if (!open && !revokingId) setPendingRevoke(null);
        }}
      >
        <DialogContent showCloseButton={!revokingId}>
          <DialogHeader>
            <DialogTitle>لغو ثبت «{pendingRevoke?.label ?? "دستگاه"}»؟</DialogTitle>
            <DialogDescription>
              {pendingRevoke?.activeSessionCount
                ? `ثبت این پایانه لغو می‌شود و ${sessionLabel(pendingRevoke.activeSessionCount)} آن بلافاصله پایان می‌یابد.`
                : "ثبت این پایانه لغو می‌شود. اعتبارنامه‌های بیومتریک کارکنان حذف نمی‌شوند، اما دیگر به این پایانه محدود نخواهند بود."}
            </DialogDescription>
          </DialogHeader>
          <ErrorBox>{pendingRevoke ? error : ""}</ErrorBox>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingRevoke(null)}
              disabled={Boolean(revokingId)}
            >
              انصراف
            </Button>
            <Button type="button" variant="destructive" onClick={() => void revoke()} disabled={Boolean(revokingId)}>
              {revokingId ? "در حال لغو…" : "لغو ثبت دستگاه"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
