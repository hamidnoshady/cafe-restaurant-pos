"use client";

/**
 * The business workspace's panels, split out of the old single-page console
 * view so each section page composes two or three of them instead of one
 * thousand-line scroll. Every panel reads (and saves through) the shared
 * `useBusiness()` context, so a write in one section refreshes the identity
 * header and the sidebar without a remount.
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPersianNumber } from "@/lib/digits";
import { validateSubdomain } from "@/lib/slug";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import {
  api,
  errorMessage,
  ErrorBox,
  InfoBox,
  Field,
  Button,
  Card,
  inputClass,
  useCan,
  SkeletonRows,
} from "../../ui";
import { IndustryPicker } from "../../industry-picker";
import { useBusiness } from "./context";

/**
 * Name + timezone. The workspace header shows who this is; this card is the
 * ordinary metadata edit — deliberately kept separate from subdomain and
 * industry, which each carry their own confirmation and side effects.
 */
export function BusinessDetailsPanel() {
  const { business, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [name, setName] = useState(business?.name ?? "");
  const [timezone, setTimezone] = useState(business?.timezone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!business) return;
    setName(business.name);
    setTimezone(business.timezone);
  }, [business]);

  if (!business) return null;
  const changed = name.trim() !== business.name || timezone.trim() !== business.timezone;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), timezone: timezone.trim() }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ویرایش کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>اطلاعات کسب‌وکار ذخیره شد.</InfoBox> : null}
      <form onSubmit={save} className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نام کسب‌وکار">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <Field label="منطقهٔ زمانی" hint="مانند Asia/Tehran">
          <input
            required
            dir="ltr"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            disabled={!editable}
            className={inputClass}
          />
        </Field>
        <div className="mb-4 min-w-0">
          <p className="mb-1 text-sm font-medium text-foreground">شناسهٔ کسب‌وکار</p>
          <p
            className="break-all rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground"
            dir="ltr"
          >
            {business.slug}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">این شناسه برای پایداری ارجاع‌ها تغییر نمی‌کند.</p>
        </div>
        {editable ? (
          <div className="mb-4 flex items-end sm:justify-end">
            <Button type="submit" disabled={busy || !changed} className="w-full sm:w-auto">
              {busy ? "در حال ذخیره…" : "ذخیرهٔ تغییرات"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 25 Wave 1 — change which industry a business operates in.
 *
 * Migration 0048 made `industry` immutable *by omission*: no update route
 * existed, because the chart of accounts is seeded from it at creation and
 * there was no way to reconcile a switch. This panel is the deliberate
 * reversal of that, so a mis-provisioned tenant does not need a factory reset.
 *
 * What it cannot do is rewrite history, and it says so rather than implying
 * otherwise: seeding is additive, the old industry's rows stay in place but
 * become unreachable, and the counts below are the server's real numbers so
 * the admin confirms against facts instead of a generic warning.
 */
export function IndustryPanel() {
  const { business, industryCounts, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [industry, setIndustry] = useState<Industry>(business?.industry ?? "food_service");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSaved(null);
    if (business) setIndustry(business.industry);
  }, [business]);

  if (!business) return null;
  const changed = industry !== business.industry;
  const counts = industryCounts;
  const carried = counts
    ? [
        { label: "آیتم منو", value: counts.menuItems },
        { label: "کالای صنفی", value: counts.industryItems },
        { label: "سفارش", value: counts.orders },
        { label: "سند حسابداری", value: counts.journalEntries },
      ].filter((c) => c.value > 0)
    : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const warning =
      carried.length > 0
        ? "\n\nاین کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:\n" +
          carried.map((c) => `• ${c.label}: ${formatPersianNumber(c.value)}`).join("\n") +
          "\n\nاین داده‌ها حذف نمی‌شوند، اما پس از تغییر نوع، دیگر از داشبورد در دسترس نخواهند بود. " +
          "سرفصل‌های حساب موجود هم دست‌نخورده می‌مانند و فقط حساب‌های نبودهٔ نوع جدید اضافه می‌شوند."
        : "";
    if (
      !window.confirm(
        `نوع «${business!.name}» از «${INDUSTRY_LABELS[business!.industry]}» به «${INDUSTRY_LABELS[industry]}» تغییر کند؟` +
          warning,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(null);
    const { ok, data } = await api<{ seededAccountCodes?: string[]; error?: string }>(
      `/api/platform/businesses/${business!.id}`,
      { method: "PATCH", body: JSON.stringify({ industry }) },
    );
    setBusy(false);
    if (ok) {
      const seeded = data.seededAccountCodes?.length ?? 0;
      setSaved(
        seeded > 0
          ? `نوع کسب‌وکار تغییر کرد و ${formatPersianNumber(seeded)} سرفصل حساب جدید اضافه شد.`
          : "نوع کسب‌وکار تغییر کرد. سرفصل حساب جدیدی لازم نبود.",
      );
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نوع کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>{saved}</InfoBox> : null}
      <form onSubmit={save}>
        <p className="mb-3 text-sm text-muted-foreground">
          نوع فعلی:{" "}
          <span className="font-medium text-foreground">{INDUSTRY_LABELS[business.industry]}</span>
        </p>
        <IndustryPicker value={industry} onChange={setIndustry} disabled={!editable || busy} />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          نوع کسب‌وکار تعیین می‌کند چه سرفصل حساب‌هایی ساخته می‌شود، مالک چه مراحلی از راه‌اندازی را
          می‌بیند، و داشبورد کدام ماژول‌ها را نشان می‌دهد.
        </p>
        {changed && carried.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5 text-xs leading-6 text-amber-800/90 dark:text-amber-200/90">
            <p className="font-medium">این کسب‌وکار داده‌ای دارد که به نوع فعلی تعلق دارد:</p>
            <ul className="mt-1 space-y-0.5">
              {carried.map((c) => (
                <li key={c.label}>
                  {c.label}: {formatPersianNumber(c.value)}
                </li>
              ))}
            </ul>
            <p className="mt-1.5">
              چیزی حذف نمی‌شود؛ اما این داده‌ها پس از تغییر از داشبورد در دسترس نخواهند بود.
            </p>
          </div>
        ) : null}
        {editable ? (
          <div className="mt-4">
            <Button type="submit" disabled={busy || !changed}>
              {busy ? "در حال تغییر…" : "تغییر نوع کسب‌وکار"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

/**
 * Phase 23 — the business's public host.
 *
 * Renaming an origin is not an ordinary metadata edit: it writes the old name
 * into `business_subdomain_aliases` so existing links keep resolving, and it
 * invalidates every live session on the old host. The admin is told that
 * before they confirm, not after.
 */
export function SubdomainPanel() {
  const { business, rootDomain, aliases, reload } = useBusiness();
  const can = useCan();
  const editable = can("business.edit");
  const [subdomain, setSubdomain] = useState(business?.subdomain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (business) setSubdomain(business.subdomain);
    setSaved(false);
  }, [business]);

  if (!business) return null;
  const trimmed = subdomain.trim().toLowerCase();
  const invalid = trimmed ? validateSubdomain(trimmed) : "invalid_subdomain";
  const changed = trimmed !== business.subdomain.toLowerCase();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (
      !window.confirm(
        `نشانی این کسب‌وکار به «${trimmed}» تغییر کند؟\n\n` +
          "نشانی قبلی همچنان به نشانی جدید هدایت می‌شود، اما نشست‌های بازِ کاربران روی نشانی قبلی " +
          "باطل می‌شود و باید دوباره وارد شوند.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ subdomain: trimmed }),
    });
    setBusy(false);
    if (ok) {
      setSaved(true);
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="نشانی اینترنتی">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>نشانی تغییر کرد. نشانی قبلی به نشانی جدید هدایت می‌شود.</InfoBox> : null}
      <form onSubmit={save}>
        <Field
          label="زیردامنه"
          hint={
            invalid ? undefined : rootDomain
              ? `https://${trimmed}.${rootDomain}`
              : "فقط حروف انگلیسی کوچک، رقم و خط تیره."
          }
        >
          <input
            dir="ltr"
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            disabled={!editable}
            className={`${inputClass} text-start`}
          />
          {invalid && changed ? (
            <span className="mt-1 block text-xs text-rose-700 dark:text-rose-300">{errorMessage(invalid)}</span>
          ) : null}
        </Field>

        {aliases.length > 0 ? (
          <div className="mb-4">
            <p className="mb-1 text-sm font-medium text-foreground">نشانی‌های قبلی</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {aliases.map((a) => (
                <li key={a.alias} dir="ltr">
                  {rootDomain ? `${a.alias}.${rootDomain}` : a.alias}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              این نشانی‌ها همچنان کار می‌کنند و به نشانی فعلی هدایت می‌شوند.
            </p>
          </div>
        ) : null}

        {editable ? (
          <Button type="submit" disabled={busy || !changed || Boolean(invalid)}>
            {busy ? "در حال تغییر…" : "تغییر نشانی"}
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

interface Feature {
  key: string;
  name: string;
  description: string | null;
  defaultEnabled: boolean;
  override: boolean | null;
  effective: boolean;
}

export function FeaturesPanel() {
  const { business, version } = useBusiness();
  const can = useCan();
  const editable = can("features.write");
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!business) return;
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${business.id}/features`,
    );
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }, [business]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!business) return null;
  const bizId = business.id;

  async function setOverride(flagKey: string, enabled: boolean | null) {
    setPending(flagKey);
    setError(null);
    const { ok, data } = await api<{ features: Feature[]; error?: string }>(
      `/api/platform/businesses/${bizId}/features`,
      { method: "PATCH", body: JSON.stringify({ flagKey, enabled }) },
    );
    setPending(null);
    if (ok) setFeatures(data.features);
    else setError(errorMessage(data.error));
  }

  return (
    <Card title="پرچم‌های ویژگی">
      <ErrorBox>{error}</ErrorBox>
      {features === null ? (
        <SkeletonRows rows={3} />
      ) : features.length === 0 ? (
        <p className="text-sm text-muted-foreground">پرچمی تعریف نشده است.</p>
      ) : (
        <div className="space-y-2">
          {features.map((f) => (
            <div
              key={f.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">{f.name}</p>
                {f.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{f.description}</p>
                ) : null}
                <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                  {f.key}
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
                <span
                  className={
                    f.effective
                      ? "rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                      : "rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {f.effective ? "فعال" : "غیرفعال"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {f.override === null
                    ? `پیش‌فرض (${f.defaultEnabled ? "روشن" : "خاموش"})`
                    : "بازنویسی‌شده"}
                </span>
                {editable ? (
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, true)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      روشن
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key}
                      onClick={() => setOverride(f.key, false)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      خاموش
                    </button>
                    <button
                      type="button"
                      disabled={pending === f.key || f.override === null}
                      onClick={() => setOverride(f.key, null)}
                      className="rounded-lg border border-border px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      پیش‌فرض
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface Grant {
  id: string;
  platformAdminId: string;
  operatorName: string | null;
  operatorRole: string | null;
  mode: "read_only" | "controlled" | "full" | "emergency";
  reason: string;
  ticketId: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
}

interface TicketOption { id: string; subject: string; status: string }

const MODE_LABELS: Record<Grant["mode"], string> = {
  read_only: "فقط خواندنی",
  controlled: "دسترسی محدود فنی",
  full: "دسترسی کامل",
  emergency: "دسترسی اضطراری",
};

export function ImpersonationPanel() {
  const { business, setNotice, version } = useBusiness();
  const can = useCan();
  const searchParams = useSearchParams();
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [tickets, setTickets] = useState<TicketOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [mode, setMode] = useState<"read_only" | "controlled" | "full">("read_only");
  const [minutes, setMinutes] = useState(30);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!business) return;
    const [grantResult, ticketResult] = await Promise.all([
      api<{ grants: Grant[]; error?: string }>(`/api/platform/impersonation?businessId=${business.id}`),
      api<{ tickets: TicketOption[] }>(`/api/platform/support/tickets?businessId=${business.id}&pageSize=100`),
    ]);
    if (grantResult.ok) setGrants(grantResult.data.grants);
    else setError(errorMessage(grantResult.data.error));
    if (ticketResult.ok) setTickets(ticketResult.data.tickets.filter((t) => !["closed", "resolved"].includes(t.status)));
  }, [business]);

  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => {
    const linkedTicket = searchParams.get("ticketId");
    if (!linkedTicket) return;
    setTicketId(linkedTicket);
    const ticket = tickets.find((candidate) => candidate.id === linkedTicket);
    if (ticket && !reason) setReason(`تیکت پشتیبانی ${ticket.id.slice(0, 8)} — ${ticket.subject}`);
    setOpen(true);
  }, [reason, searchParams, tickets]);
  if (!business) return null;

  const isActive = (g: Grant) => !g.endedAt && !g.revokedAt && new Date(g.expiresAt).getTime() > Date.now();
  const active = (grants ?? []).find(isActive) ?? null;

  async function enter() {
    if (reason.trim().length < 10) { setError("دلیل نشست باید دست‌کم ۱۰ نویسه و روشن باشد."); return; }
    setBusy(true); setError(null);
    const { ok, data } = await api<{ handoffUrl?: string; error?: string; code?: string }>(
      `/api/platform/businesses/${business!.id}/impersonate`,
      { method: "POST", body: JSON.stringify({ mode, reason: reason.trim(), ticketId: ticketId || undefined, minutes }) },
    );
    setBusy(false);
    if (ok) window.location.href = data.handoffUrl ?? "/dashboard";
    else if (data.code === "ACTIVE_SUPPORT_SESSION_EXISTS") setError("یک نشست فعال دارید؛ ابتدا همان نشست را ادامه دهید یا پایان دهید.");
    else setError(errorMessage(data.error));
  }

  async function closeGrant(grant: Grant, revoke: boolean) {
    setBusy(true); setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/impersonation/${grant.id}${revoke ? "?action=revoke" : ""}`, { method: "DELETE" });
    setBusy(false);
    if (ok) { setNotice(revoke ? "نشست پشتیبانی لغو شد." : "نشست پشتیبانی پایان یافت."); void load(); }
    else setError(errorMessage(data.error));
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {active ? (
        <Card title="نشست پشتیبانی فعال">
          <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <p><span className="block text-xs text-muted-foreground">اپراتور</span>{active.operatorName ?? "اپراتور پلتفرم"} · {active.operatorRole ?? "—"}</p>
            <p><span className="block text-xs text-muted-foreground">نوع دسترسی</span>{MODE_LABELS[active.mode]}</p>
            <p><span className="block text-xs text-muted-foreground">دلیل</span>{active.reason}</p>
            <p><span className="block text-xs text-muted-foreground">تیکت مرتبط</span>{active.ticketId ? `#${active.ticketId.slice(0, 8)}` : "بدون تیکت"}</p>
            <p><span className="block text-xs text-muted-foreground">شروع</span>{new Date(active.createdAt).toLocaleString("fa-IR")}</p>
            <p><span className="block text-xs text-muted-foreground">پایان خودکار</span>{new Date(active.expiresAt).toLocaleString("fa-IR")}</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => setOpen(true)} disabled={busy}>ادامه نشست فعلی</Button>
            <Button variant="ghost" onClick={() => void closeGrant(active, false)} disabled={busy}>پایان نشست من</Button>
            {can("impersonate.revoke") ? <Button variant="danger" onClick={() => void closeGrant(active, true)} disabled={busy}>لغو نشست</Button> : null}
          </div>
        </Card>
      ) : (
        <Card title="شروع نشست پشتیبانی">
          <p className="mb-4 text-sm text-muted-foreground">دسترسی موقت، ثبت‌شده و قابل لغو است. حالت فقط‌خواندنی گزینهٔ پیش‌فرض است.</p>
          <Button onClick={() => setOpen(true)}>شروع نشست</Button>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>شروع نشست پشتیبانی</DialogTitle><DialogDescription>کسب‌وکار: {business.name}</DialogDescription></DialogHeader>
            <div className="mt-4">
              <Field label="دلیل دسترسی" hint="الزامی؛ دست‌کم ۱۰ نویسه">
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} min-h-24 py-2`} placeholder="مثلاً: بررسی مشکل شناسایی نشدن چاپگر فاکتور" />
              </Field>
              <Field label="تیکت مرتبط">
                <select value={ticketId} onChange={(e) => setTicketId(e.target.value)} className={inputClass}>
                  <option value="">بدون تیکت</option>
                  {tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>#{ticket.id.slice(0, 8)} — {ticket.subject}</option>)}
                </select>
              </Field>
              <Field label="سطح دسترسی">
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className={inputClass}>
                  {can("impersonate.readOnly") ? <option value="read_only">فقط خواندنی (پیشنهادی)</option> : null}
                  {can("impersonate.controlled") ? <option value="controlled">دسترسی محدود فنی</option> : null}
                  {can("impersonate.full") ? <option value="full">دسترسی کامل — پرخطر</option> : null}
                </select>
              </Field>
              <Field label="مدت">
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={inputClass}>
                  {[15, 30, 45, 60].map((value) => <option key={value} value={value}>{formatPersianNumber(value)} دقیقه</option>)}
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>انصراف</Button>
              <Button variant={mode === "full" ? "danger" : "primary"} onClick={() => void enter()} disabled={busy || reason.trim().length < 10}>{busy ? "در حال ایجاد…" : "ایجاد و ورود"}</Button>
            </div>
          </DialogContent>
      </Dialog>

      <Card title="تاریخچه نشست‌ها">
        {grants === null ? <SkeletonRows rows={4} /> : grants.length === 0 ? <p className="text-sm text-muted-foreground">نشستی ثبت نشده است.</p> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead><tr className="border-b border-border text-right text-xs text-muted-foreground"><th className="p-2">وضعیت</th><th className="p-2">اپراتور</th><th className="p-2">دسترسی</th><th className="p-2">دلیل</th><th className="p-2">شروع</th><th className="p-2">پایان</th></tr></thead><tbody>{grants.map((g) => <tr key={g.id} className="border-b border-border/60"><td className="p-2">{isActive(g) ? "فعال" : g.revokedAt ? "لغوشده" : g.endedAt ? "پایان‌یافته" : "منقضی"}</td><td className="p-2">{g.operatorName ?? "—"}</td><td className="p-2">{MODE_LABELS[g.mode]}</td><td className="max-w-xs truncate p-2">{g.reason}</td><td className="p-2">{new Date(g.createdAt).toLocaleString("fa-IR")}</td><td className="p-2">{g.endedAt ? new Date(g.endedAt).toLocaleString("fa-IR") : "—"}</td></tr>)}</tbody></table></div>
        )}
      </Card>
      <Card title="سیاست امنیتی پشتیبانی"><p className="text-sm leading-6 text-muted-foreground">هر نشست موقت است، شناسهٔ دقیق مجوز در هر درخواست دوباره بررسی می‌شود و تغییرات مجاز با هویت اپراتور ثبت می‌شوند. اطلاعات محرمانه و خروجی‌های حساس جزو دسترسی عادی پشتیبانی نیستند.</p></Card>
    </div>
  );
}

/**
 * Both reset and remove are immediate and irreversible with no other safety
 * net (no archive step, no grace window), so both are confirmed by typing
 * this same fixed phrase rather than the business's own (often Persian, so
 * tedious to retype exactly) slug. Must match `DESTRUCTIVE_CONFIRMATION_PHRASE`
 * in src/lib/platform-admin.ts, which the server actually enforces.
 */
const CONFIRMATION_PHRASE = "delete-me";

export function ResetPanel() {
  const { business, reload, setNotice } = useBusiness();
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.reset")) return null;

  async function reset() {
    if (
      !window.confirm(
        `همهٔ داده‌های «${business!.name}» حذف شود و کسب‌وکار از ابتدا راه‌اندازی شود؟ این عمل برگشت‌ناپذیر است.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "POST",
      body: JSON.stringify({ confirmation }),
    });
    setBusy(false);
    if (ok) {
      setConfirmation("");
      setNotice("داده‌های کسب‌وکار پاک شد. مالک باید دوباره وارد شود و راه‌اندازی اولیه را انجام دهد.");
      void reload();
    } else {
      setError(errorMessage(data.error));
    }
  }

  return (
    <Card title="ریست کامل داده‌ها">
      <ErrorBox>{error}</ErrorBox>
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">همهٔ داده‌های این کسب‌وکار حذف می‌شوند.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          سفارش‌ها، انبار، حسابداری، تنظیمات، شعبه‌ها، کاربران و دسترسی‌های ویژگی پاک می‌شوند. تنها
          هویت سراسری مالک و پلن کسب‌وکار باقی می‌ماند تا راه‌اندازی از ابتدا انجام شود.
        </p>
      </div>
      <div className="mt-4">
        <Field label={`برای تأیید، عبارت زیر را دقیق وارد کنید: ${CONFIRMATION_PHRASE}`}>
          <input
            dir="ltr"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            className={inputClass}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
          />
        </Field>
        <Button
          variant="danger"
          onClick={reset}
          disabled={busy || confirmation.trim() !== CONFIRMATION_PHRASE}
          className="w-full sm:w-auto"
        >
          {busy ? "در حال ریست…" : "حذف داده‌ها و شروع مجدد"}
        </Button>
      </div>
    </Card>
  );
}

export function RemovePanel() {
  const { business } = useBusiness();
  const can = useCan();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!business || !can("business.delete")) return null;

  async function remove() {
    if (
      !window.confirm(`«${business!.name}» برای همیشه حذف شود؟ این عمل قطعی و بازگشت‌ناپذیر است.`)
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${business!.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
    if (ok) {
      window.location.href = "/platform";
      return;
    }
    setBusy(false);
    setError(errorMessage(data.error));
  }

  return (
    <Card title="حذف کسب‌وکار">
      <ErrorBox>{error}</ErrorBox>
      <div className="rounded-lg border border-red-500/25 bg-red-500/8 p-3 text-sm text-red-900 dark:text-red-100">
        <p className="font-semibold">این کسب‌وکار برای همیشه حذف می‌شود.</p>
        <p className="mt-1 text-red-900/70 dark:text-red-100/70">
          فوری و قطعی است — بدون بایگانی و بدون مهلت. همهٔ داده‌ها، کاربران، شعبه‌ها و اطلاعات
          کسب‌وکار از بین می‌روند.
        </p>
      </div>
      <div className="mt-4">
        <Field label={`برای تأیید، عبارت زیر را دقیق وارد کنید: ${CONFIRMATION_PHRASE}`}>
          <input
            dir="ltr"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            className={inputClass}
            placeholder={CONFIRMATION_PHRASE}
            autoComplete="off"
          />
        </Field>
        <Button
          variant="danger"
          onClick={remove}
          disabled={busy || confirmation.trim() !== CONFIRMATION_PHRASE}
          className="w-full sm:w-auto"
        >
          {busy ? "در حال حذف…" : "حذف قطعی کسب‌وکار"}
        </Button>
      </div>
    </Card>
  );
}
