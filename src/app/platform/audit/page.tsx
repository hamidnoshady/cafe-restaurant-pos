"use client";

/**
 * Phase 15 — the platform audit log.
 *
 * Every privileged cross-tenant action, newest first: who did it, to which
 * business, when. This is the console's accountability surface — the record
 * that impersonation and lifecycle changes cannot happen unseen (exit
 * criterion 3). Read-only; any admin may view it.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { api, errorMessage, ErrorBox, Card } from "../ui";

interface AuditEntry {
  id: string;
  adminName: string | null;
  businessId: string | null;
  businessName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "business.provision": "ایجاد کسب‌وکار",
  "business.active": "فعال‌سازی",
  "business.suspended": "تعلیق",
  "business.archived": "بایگانی",
  "business.delete": "حذف قطعی",
  "business.plan": "تغییر پلن",
  "business.edit": "ویرایش کسب‌وکار",
  "business.subdomain": "تغییر نشانی (ساب‌دامنه)",
  "business.industry_change": "تغییر نوع کسب‌وکار",
  "business.reset": "ریست کامل کسب‌وکار",
  "feature.override": "بازنویسی پرچم ویژگی",
  "impersonation.start": "شروع دسترسی پشتیبانی",
  "impersonation.end": "پایان دسترسی پشتیبانی",
  "impersonation.revoke": "لغو دسترسی پشتیبانی",
};

function fmtDate(iso: string): string {
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(iso),
      ),
    );
  } catch {
    return iso;
  }
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { ok, data } = await api<{ entries: AuditEntry[]; error?: string }>(
        "/api/platform/audit",
      );
      if (ok) setEntries(data.entries);
      else setError(errorMessage(data.error));
    })();
  }, []);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-6 text-xl font-bold">رویدادها</h1>
      <ErrorBox>{error}</ErrorBox>

      {entries === null ? (
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
      ) : entries.length === 0 ? (
        <Card>
          <p className="text-sm text-white/50">رویدادی ثبت نشده است.</p>
        </Card>
      ) : (
        <>
          <div className="space-y-3 md:hidden">
            {entries.map((e) => (
              <div key={e.id} className="rounded-xl border border-white/10 bg-white/3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-white/90">{ACTION_LABELS[e.action] ?? e.action}</p>
                    <p className="mt-1 text-xs text-white/45">{fmtDate(e.createdAt)}</p>
                  </div>
                  <span className="text-xs text-white/55">{e.adminName ?? "—"}</span>
                </div>
                <div className="mt-4 border-t border-white/5 pt-3 text-sm">
                  <p className="text-xs text-white/40">کسب‌وکار</p>
                  {e.businessId ? (
                    <Link
                      href={"/platform/businesses/" + e.businessId}
                      className="mt-1 inline-block break-all text-sky-300 hover:underline"
                    >
                      {e.businessName ?? e.businessId}
                    </Link>
                  ) : (
                    <p className="mt-1 break-all text-white/50">{e.businessName ?? "—"}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-white/10 md:block">
            <table className="min-w-[680px] w-full text-sm">
              <thead className="bg-white/3 text-white/50">
                <tr>
                  <th className="px-4 py-3 text-start font-medium">زمان</th>
                  <th className="px-4 py-3 text-start font-medium">مدیر</th>
                  <th className="px-4 py-3 text-start font-medium">اقدام</th>
                  <th className="px-4 py-3 text-start font-medium">کسب‌وکار</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-white/5">
                    <td className="whitespace-nowrap px-4 py-3 text-white/50">
                      {fmtDate(e.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-white/80">{e.adminName ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className="text-white/90">
                        {ACTION_LABELS[e.action] ?? e.action}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {e.businessId ? (
                        <Link
                          href={"/platform/businesses/" + e.businessId}
                          className="text-sky-300 hover:underline"
                        >
                          {e.businessName ?? e.businessId}
                        </Link>
                      ) : (
                        <span className="text-white/40">{e.businessName ?? "—"}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
