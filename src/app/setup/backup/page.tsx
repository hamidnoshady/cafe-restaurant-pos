"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Optional wizard step, shown only on a local-only install: where the nightly
 * backup is written.
 *
 * On the desktop app the folder picker is a real OS dialog, exposed by the
 * Electron preload bridge; anywhere else (a browser hitting a local server)
 * it degrades to typing the path, which is the only thing a browser can do.
 */
import { useEffect, useState } from "react";
import { SetupDataSkeleton, StepShell } from "../ui";
import { useRouter } from "next/navigation";
import { nextPath, prevPath } from "../steps";

declare global {
  interface Window {
    desktop?: { pickFolder: () => Promise<string | null> };
  }
}

interface BackupConfigResponse {
  config?: {
    enabled: boolean;
    intervalHours: number;
    anchorTime: string;
    localRetention: number;
    directory: string;
  };
  localOnly?: boolean;
}

export default function BackupStepPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [anchorTime, setAnchorTime] = useState("03:30");
  const [localRetention, setLocalRetention] = useState(14);
  const [directory, setDirectory] = useState("");
  const [canPick, setCanPick] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCanPick(typeof window !== "undefined" && Boolean(window.desktop?.pickFolder));
    fetch("/api/backup/config")
      .then((r) => r.json())
      .then((data: BackupConfigResponse) => {
        setLocalOnly(Boolean(data.localOnly));
        if (data.config) {
          setEnabled(data.config.enabled);
          setAnchorTime(data.config.anchorTime);
          setLocalRetention(data.config.localRetention);
          setDirectory(data.config.directory ?? "");
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // A connected install has nothing to configure here — the dashboard's backup
  // page covers both halves — so this step just steps aside.
  useEffect(() => {
    if (loaded && !localOnly) router.replace(nextPath("backup"));
  }, [loaded, localOnly, router]);

  async function pick() {
    const chosen = await window.desktop?.pickFolder();
    if (chosen) setDirectory(chosen);
  }

  async function save(skip: boolean) {
    setBusy(true);
    setError("");
    if (!skip) {
      const res = await fetch("/api/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          intervalHours: 24,
          anchorTime,
          localRetention,
          directory,
          cloud: { enabled: false },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setBusy(false);
        setError(
          data.error === "cloud_backup_unavailable_local"
            ? "در نصب محلی، پشتیبان‌گیری ابری در دسترس نیست."
            : "ذخیرهٔ تنظیمات پشتیبان‌گیری ممکن نشد.",
        );
        return;
      }
    }
    await fetch("/api/setup/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "backup" }),
    }).catch(() => {});
    router.push(nextPath("backup"));
  }

  if (!loaded || !localOnly) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="backup"
      description={
        "این نصب محلی است، بنابراین نسخه‌های پشتیبان روی همین دستگاه ساخته می‌شوند. یک پوشه — " +
        "ترجیحاً روی یک درایو دیگر یا حافظهٔ خارجی — انتخاب کنید."
      }
    >

      {error ? (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          پشتیبان‌گیری خودکار شبانه فعال باشد
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">پوشهٔ مقصد</span>
          <div className="flex gap-2">
            <input
              className="w-full rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
              dir="ltr"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="D:\pos-backups"
            />
            {canPick ? (
              <button
                type="button"
                onClick={() => void pick()}
                className="shrink-0 rounded-lg border border-input px-4 text-sm hover:bg-muted"
              >
                انتخاب پوشه…
              </button>
            ) : null}
          </div>
          <span className="mt-1 block text-xs text-muted-foreground">
            خالی بگذارید تا از مسیر پیش‌فرض استفاده شود.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">ساعت اجرا</span>
          <input
            className="rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            type="time"
            value={anchorTime}
            onChange={(e) => setAnchorTime(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">تعداد نسخه‌های نگهداری‌شده</span>
          <PersianNumberInput
            className="w-32 rounded-lg border border-input px-3 py-2 text-sm outline-none focus:border-primary"
            dir="ltr"
            value={localRetention}
            onChange={(e) => setLocalRetention(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-8 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            const previous = prevPath("backup");
            if (previous) router.push(previous);
          }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← مرحلهٔ قبل
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            className="rounded-lg border border-input px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            فعلاً رد شو
          </button>
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={busy}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
          >
            {busy ? "در حال ذخیره…" : "ذخیره و ادامه"}
          </button>
        </div>
      </div>
    </StepShell>
  );
}
