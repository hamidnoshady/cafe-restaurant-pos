"use client";

/**
 * Phase 15 — the console landing list: every business on the deployment.
 *
 * Reads `/api/platform/businesses` (any admin), and — for operators holding
 * `business.provision` — opens the provision form inline. Provisioning here
 * seeds the chart of accounts, so the owner it creates can log straight in and
 * sell (exit criterion 1).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  StatusBadge,
  inputClass,
  useCan,
} from "./ui";

interface Business {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  locationCount: number;
  memberCount: number;
  createdAt: string;
}

function formatDate(iso: string): string {
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium" }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}

export default function BusinessesPage() {
  const can = useCan();
  const [businesses, setBusinesses] = useState<Business[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ businesses: Business[]; error?: string }>(
      "/api/platform/businesses",
    );
    if (ok) setBusinesses(data.businesses);
    else setError(errorMessage(data.error));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">کسب‌وکارها</h1>
          <p className="mt-1 text-sm text-white/40">
            {businesses ? `${toPersianDigits(businesses.length)} کسب‌وکار` : "…"}
          </p>
        </div>
        {can("business.provision") ? (
          <Button onClick={() => setShowForm((v) => !v)}>
            {showForm ? "بستن" : "ایجاد کسب‌وکار"}
          </Button>
        ) : null}
      </div>

      <ErrorBox>{error}</ErrorBox>

      {showForm && can("business.provision") ? (
        <div className="mb-6">
          <ProvisionForm
            onDone={() => {
              setShowForm(false);
              void load();
            }}
          />
        </div>
      ) : null}

      {businesses === null ? (
        <p className="text-sm text-white/50">در حال بارگذاری…</p>
      ) : businesses.length === 0 ? (
        <Card>
          <p className="text-sm text-white/50">هنوز کسب‌وکاری ثبت نشده است.</p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-white/3 text-white/50">
              <tr>
                <th className="px-4 py-3 text-start font-medium">نام</th>
                <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                <th className="px-4 py-3 text-start font-medium">پلن</th>
                <th className="px-4 py-3 text-start font-medium">شعبه</th>
                <th className="px-4 py-3 text-start font-medium">اعضا</th>
                <th className="px-4 py-3 text-start font-medium">ایجاد</th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((b) => (
                <tr
                  key={b.id}
                  className="border-t border-white/5 transition-colors hover:bg-white/3"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/platform/businesses/${b.id}`}
                      className="font-medium text-sky-300 hover:underline"
                    >
                      {b.name}
                    </Link>
                    <span className="mt-0.5 block text-xs text-white/30" dir="ltr">
                      {b.slug}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-white/70">{b.plan}</td>
                  <td className="px-4 py-3 text-white/70">
                    {formatPersianNumber(b.locationCount)}
                  </td>
                  <td className="px-4 py-3 text-white/70">{formatPersianNumber(b.memberCount)}</td>
                  <td className="px-4 py-3 text-white/50">{formatDate(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProvisionForm({ onDone }: { onDone: () => void }) {
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [locationName, setLocationName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/businesses", {
      method: "POST",
      body: JSON.stringify({
        businessName: businessName.trim(),
        ownerName: ownerName.trim(),
        email: email.trim().toLowerCase(),
        password,
        locationName: locationName.trim() || undefined,
      }),
    });
    setBusy(false);
    if (ok) {
      setInfo("کسب‌وکار ایجاد شد. مالک اکنون می‌تواند وارد شود.");
      setTimeout(onDone, 800);
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ایجاد کسب‌وکار جدید">
      <form onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <InfoBox>{info}</InfoBox>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام کسب‌وکار">
            <input
              required
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="نام شعبه" hint="خالی بماند، «شعبه مرکزی» ساخته می‌شود.">
            <input
              value={locationName}
              onChange={(e) => setLocationName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="نام مالک">
            <input
              required
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="ایمیل مالک">
            <input
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} text-start`}
            />
          </Field>
          <Field label="رمز عبور مالک" hint="حداقل ۸ نویسه.">
            <input
              type="password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="mt-2">
          <Button type="submit" disabled={busy}>
            {busy ? "در حال ایجاد…" : "ایجاد و راه‌اندازی"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
