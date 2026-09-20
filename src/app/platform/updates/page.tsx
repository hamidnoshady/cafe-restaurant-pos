"use client";

/**
 * Cross-business release-version visibility. Desktop installation remains a
 * manual, signed release process; this page deliberately contains no storage
 * credentials, download URL, or execute/update control.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { api, errorMessage, ErrorBox, InfoBox, Card, PlatformPageSkeleton } from "../ui";

interface ClientStatus {
  businessId: string;
  businessName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}

function ComplianceBadge({ client }: { client: ClientStatus }) {
  if (client.error) {
    return <span className="rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs text-red-700 dark:text-red-300">خطا</span>;
  }
  if (client.updateAvailable) {
    return <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">نیازمند بررسی نسخه</span>;
  }
  return <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">هم‌نسخه</span>;
}

export default function UpdatesPage() {
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ clients: ClientStatus[]; error?: string }>("/api/platform/updates");
    if (ok) {
      setClients(data.clients ?? []);
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <PlatformPageSkeleton />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 sm:space-y-6">
      <h1 className="text-xl font-bold">وضعیت نسخهٔ نصب‌های محلی</h1>
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>
        به‌روزرسانی خودکار در این نسخه غیرفعال است. این صفحه فقط نسخهٔ گزارش‌شده را نشان می‌دهد؛ هیچ فایل یا
        تصویر Docker دانلود و اجرا نمی‌شود. انتشار و نصب باید از مسیر دستی، امضاشده و تأییدشده انجام شود.
      </InfoBox>

      <Card title="نسخهٔ گزارش‌شدهٔ هر کسب‌وکار">
        <p className="mb-4 text-sm text-muted-foreground">
          فقط سایت‌هایی که ارتباط ابری را فعال کرده‌اند می‌توانند نسخه را گزارش کنند. نصب کاملاً آفلاین در این
          فهرست دیده نمی‌شود.
        </p>
        {clients.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز هیچ سایتی وضعیت نسخه گزارش نکرده است.</p>
        ) : (
          <ul className="space-y-2">
            {clients.map((client) => (
              <li key={client.businessId} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{client.businessName}</span>
                  <ComplianceBadge client={client} />
                </div>
                <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>نسخهٔ سایت: <code dir="ltr">{client.currentVersion}</code></span>
                  <span>نسخهٔ مرکزی: <code dir="ltr">{client.latestVersion ?? "—"}</code></span>
                  <span>آخرین بررسی: {fmtDate(client.checkedAt)}</span>
                </div>
                {client.error ? <p className="mt-2 text-xs text-destructive">{client.error}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
