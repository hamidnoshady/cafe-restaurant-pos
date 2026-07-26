"use client";

/**
 * Phase 15 — the platform-admin roster (owner-only).
 *
 * Who operates the console and at what role. Read-only here: the seed script
 * (`npm run db:platform-admin`) is the deliberate way admins are minted, so the
 * console shows the roster without exposing a create-admin button that would
 * itself need careful gating. `admins.manage` gates both this page (in the nav)
 * and its API.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import { api, errorMessage, ErrorBox, Card } from "../ui";

interface Admin {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
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

function roleLabel(role: string): string {
  return PLATFORM_ROLE_LABELS[role as PlatformAdminRole] ?? role;
}

export default function AdminsPage() {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { ok, data } = await api<{ admins: Admin[]; error?: string }>("/api/platform/admins");
      if (ok) setAdmins(data.admins);
      else setError(errorMessage(data.error));
    })();
  }, []);

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-2 text-xl font-bold">مدیران سکو</h1>
      <p className="mb-6 text-sm text-white/40">
        مدیران جدید از طریق اسکریپت <code dir="ltr">npm run db:platform-admin</code> ساخته می‌شوند.
      </p>
      <ErrorBox>{error}</ErrorBox>

      {admins === null ? (
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
      ) : admins.length === 0 ? (
        <Card>
          <p className="text-sm text-white/50">مدیری ثبت نشده است.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/3 text-white/50">
              <tr>
                <th className="px-4 py-3 text-start font-medium">نام</th>
                <th className="px-4 py-3 text-start font-medium">ایمیل</th>
                <th className="px-4 py-3 text-start font-medium">نقش</th>
                <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                <th className="px-4 py-3 text-start font-medium">آخرین ورود</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-t border-white/5">
                  <td className="px-4 py-3 text-white/90">{a.fullName}</td>
                  <td className="px-4 py-3 text-white/60" dir="ltr">
                    {a.email}
                  </td>
                  <td className="px-4 py-3 text-white/80">{roleLabel(a.role)}</td>
                  <td className="px-4 py-3">
                    {a.isActive ? (
                      <span className="text-emerald-300">فعال</span>
                    ) : (
                      <span className="text-white/40">غیرفعال</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/50">{fmtDate(a.lastLoginAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
