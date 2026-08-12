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
import { subdomainFromBusinessName, validateSubdomain } from "@/lib/slug";
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
  subdomain: string;
  status: string;
  plan: string;
  locationCount: number;
  memberCount: number;
  createdAt: string;
}

/**
 * Phase 23 — a business still on the `biz-xxxxxxxx` host that migration 0066
 * backfilled from its slug. It works, but it is not a name anyone would print
 * on a receipt, so the console flags it for the admin to rename.
 */
function isPlaceholderSubdomain(subdomain: string): boolean {
  return /^biz-[0-9a-f]{8}$/i.test(subdomain);
}

function PlaceholderSubdomainBadge() {
  return (
    <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-300 ring-1 ring-amber-400/40">
      زیردامنه موقت
    </span>
  );
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
  const [rootDomain, setRootDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ businesses: Business[]; rootDomain?: string; error?: string }>(
      "/api/platform/businesses",
    );
    if (ok) {
      setBusinesses(data.businesses);
      setRootDomain(data.rootDomain ?? "");
    } else setError(errorMessage(data.error));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">کسب‌وکارها</h1>
          <p className="mt-1 text-sm text-white/40">
            {businesses ? `${toPersianDigits(businesses.length)} کسب‌وکار` : "…"}
          </p>
        </div>
        {can("business.provision") ? (
          <Button onClick={() => setShowForm((v) => !v)} className="w-full sm:w-auto">
            {showForm ? "بستن" : "ایجاد کسب‌وکار"}
          </Button>
        ) : null}
      </div>

      <ErrorBox>{error}</ErrorBox>

      {showForm && can("business.provision") ? (
        <div className="mb-6">
          <ProvisionForm
            rootDomain={rootDomain}
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
        <>
          <div className="space-y-3 md:hidden">
            {businesses.map((b) => (
              <BusinessListCard key={b.id} business={b} />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-white/10 md:block">
            <table className="min-w-[680px] w-full text-sm">
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
                        href={"/platform/businesses/" + b.id}
                        className="font-medium text-sky-300 hover:underline"
                      >
                        {b.name}
                      </Link>
                      <span className="mt-0.5 flex items-center gap-2 text-xs text-white/30">
                        <span dir="ltr">{b.subdomain}</span>
                        {isPlaceholderSubdomain(b.subdomain) ? <PlaceholderSubdomainBadge /> : null}
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
        </>
      )}
    </div>
  );
}

function BusinessListCard({ business }: { business: Business }) {
  return (
    <Link
      href={"/platform/businesses/" + business.id}
      className="block rounded-xl border border-white/10 bg-white/3 p-4 transition-colors hover:bg-white/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-sky-300">{business.name}</p>
          <p className="mt-1 break-all text-xs text-white/35" dir="ltr">
            {business.subdomain}
          </p>
          {isPlaceholderSubdomain(business.subdomain) ? (
            <p className="mt-1">
              <PlaceholderSubdomainBadge />
            </p>
          ) : null}
        </div>
        <StatusBadge status={business.status} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-white/40">پلن</dt>
          <dd className="mt-1 text-white/80">{business.plan}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">شعبه</dt>
          <dd className="mt-1 text-white/80">{formatPersianNumber(business.locationCount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">اعضا</dt>
          <dd className="mt-1 text-white/80">{formatPersianNumber(business.memberCount)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/40">ایجاد</dt>
          <dd className="mt-1 text-white/60">{formatDate(business.createdAt)}</dd>
        </div>
      </dl>
    </Link>
  );
}

function ProvisionForm({ onDone, rootDomain }: { onDone: () => void; rootDomain: string }) {
  const [businessName, setBusinessName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [locationName, setLocationName] = useState("");
  // Phase 23 — prefilled from the business name but editable, and left
  // untouched by later name edits once the admin has typed their own.
  const [subdomain, setSubdomain] = useState("");
  const [subdomainEdited, setSubdomainEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggested = subdomainEdited ? subdomain : subdomainFromBusinessName(businessName);
  const subdomainError = suggested ? validateSubdomain(suggested) : null;

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
        subdomain: suggested || undefined,
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
          <Field
            label="نشانی اینترنتی (زیردامنه)"
            hint={
              subdomainError
                ? undefined
                : suggested && rootDomain
                  ? `کسب‌وکار از این نشانی سرو می‌شود: https://${suggested}.${rootDomain}`
                  : "فقط حروف انگلیسی کوچک، رقم و خط تیره."
            }
          >
            <input
              dir="ltr"
              value={suggested}
              onChange={(e) => {
                setSubdomainEdited(true);
                setSubdomain(e.target.value.trim().toLowerCase());
              }}
              className={`${inputClass} text-start`}
              placeholder="acme"
            />
            {subdomainError ? (
              <span className="mt-1 block text-xs text-rose-300">{errorMessage(subdomainError)}</span>
            ) : null}
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
          <Button type="submit" disabled={busy || Boolean(subdomainError)}>
            {busy ? "در حال ایجاد…" : "ایجاد و راه‌اندازی"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
