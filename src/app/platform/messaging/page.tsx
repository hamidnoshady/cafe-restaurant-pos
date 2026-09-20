"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { formatPersianNumber } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, PlatformPageSkeleton, useCan } from "../ui";

interface PublicConfig {
  enabled: boolean;
  smsProvider: "kavenegar" | "noop";
  emailProvider: "smtp" | "noop";
  kavenegarConfigured: boolean;
  smtpConfigured: boolean;
  kavenegarSender: string;
  kavenegarKeyHint: string | null;
  smtpHost: string;
  smtpFrom: string;
  rate: { smsRialPerSegment: number; emailRialPerSend: number };
  configured: boolean;
}
interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
  isActive: boolean;
  sortOrder: number;
}
interface TopUpRequest {
  id: string;
  businessId: string;
  businessName: string | null;
  packageName: string;
  creditAmountRial: number;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
}
interface MessagingData { config: PublicConfig; packages: CreditPackage[]; requests: TopUpRequest[]; error?: string }

const fmt = (value: number) => `${formatPersianNumber(value)} ریال`;
const date = (value: string) => new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

/** The platform-owned provider credentials, credit packages and manual approvals. */
export default function PlatformMessagingPage() {
  const canManage = useCan()("messaging.manage");
  const [data, setData] = useState<MessagingData | null>(null);
  const [draft, setDraft] = useState<PublicConfig | null>(null);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [packageName, setPackageName] = useState("");
  const [packagePrice, setPackagePrice] = useState("");
  const [packageCredit, setPackageCredit] = useState("");

  const load = useCallback(async () => {
    const result = await api<MessagingData>("/api/platform/messaging");
    if (!result.ok) {
      setError(result.data.error ?? "دریافت تنظیمات پیام ممکن نشد.");
      return;
    }
    setData(result.data);
    setDraft(result.data.config);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function submit(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(""); setNotice("");
    const result = await api<{ error?: string }>("/api/platform/messaging", { method: "POST", body: JSON.stringify(body) });
    setBusy("");
    if (!result.ok) { setError(result.data.error ?? "انجام عملیات ممکن نشد."); return false; }
    setNotice("تغییرات ذخیره شد.");
    await load();
    return true;
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const saved = await submit({
      action: "config", enabled: draft.enabled, smsProvider: draft.smsProvider, emailProvider: draft.emailProvider,
      kavenegarSender: draft.kavenegarSender, kavenegarApiKey: key || undefined,
      smtpHost: draft.smtpHost, smtpFrom: draft.smtpFrom, smtpPassword: password || undefined,
      smsRialPerSegment: draft.rate.smsRialPerSegment, emailRialPerSend: draft.rate.emailRialPerSend,
    }, "config");
    if (saved) { setKey(""); setPassword(""); }
  }

  async function addPackage(event: FormEvent) {
    event.preventDefault();
    const saved = await submit({
      action: "package", name: packageName, priceRial: Number(packagePrice), creditAmountRial: Number(packageCredit),
    }, "package");
    if (saved) { setPackageName(""); setPackagePrice(""); setPackageCredit(""); }
  }

  if (!data || !draft) return <PlatformPageSkeleton />;

  return <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
    <header>
      <h1 className="text-xl font-bold">پیام‌رسانی و اعتبار</h1>
      <p className="mt-1 text-sm text-muted-foreground">کلیدهای پلتفرم، نرخ مصرف و درخواست‌های شارژ کسب‌وکارها. کلیدها هرگز دوباره نمایش داده نمی‌شوند.</p>
    </header>
    <ErrorBox>{error}</ErrorBox>{notice ? <InfoBox>{notice}</InfoBox> : null}

    <Card title="وضعیت سرویس">
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <p>ارسال: <b>{draft.enabled ? "روشن" : "خاموش"}</b></p>
        <p>پیامک: <b>{draft.kavenegarConfigured ? "کلید تنظیم شده" : "بدون کلید"}</b></p>
        <p>ایمیل: <b>{draft.smtpConfigured ? "SMTP تنظیم شده" : "بدون SMTP"}</b></p>
      </div>
    </Card>

    <Card title="ارائه‌دهنده و نرخ">
      <form onSubmit={saveConfig} className="grid gap-3 sm:grid-cols-2">
        <Field label="فعال بودن ارسال"><select className={inputClass} value={draft.enabled ? "yes" : "no"} disabled={!canManage} onChange={(e) => setDraft({ ...draft, enabled: e.target.value === "yes" })}><option value="no">خاموش</option><option value="yes">روشن</option></select></Field>
        <Field label="خط پیامک کاوه‌نگار"><input className={inputClass} value={draft.kavenegarSender} disabled={!canManage} onChange={(e) => setDraft({ ...draft, kavenegarSender: e.target.value })} /></Field>
        <Field label={`کلید کاوه‌نگار ${draft.kavenegarKeyHint ?? ""}`} hint="خالی بگذارید تا کلید قبلی حفظ شود."><input className={inputClass} type="password" autoComplete="new-password" value={key} disabled={!canManage} onChange={(e) => setKey(e.target.value)} /></Field>
        <Field label="هزینه هر قطعه پیامک (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} value={draft.rate.smsRialPerSegment} disabled={!canManage} onChange={(e) => setDraft({ ...draft, rate: { ...draft.rate, smsRialPerSegment: Number(e.target.value) } })} /></Field>
        <Field label="میزبان SMTP"><input className={inputClass} dir="ltr" value={draft.smtpHost} disabled={!canManage} onChange={(e) => setDraft({ ...draft, smtpHost: e.target.value })} /></Field>
        <Field label="فرستندهٔ ایمیل"><input className={inputClass} dir="ltr" value={draft.smtpFrom} disabled={!canManage} onChange={(e) => setDraft({ ...draft, smtpFrom: e.target.value })} /></Field>
        <Field label="گذرواژه SMTP" hint="خالی بگذارید تا گذرواژهٔ قبلی حفظ شود."><input className={inputClass} type="password" autoComplete="new-password" value={password} disabled={!canManage} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="هزینه هر ایمیل (ریال)"><PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} value={draft.rate.emailRialPerSend} disabled={!canManage} onChange={(e) => setDraft({ ...draft, rate: { ...draft.rate, emailRialPerSend: Number(e.target.value) } })} /></Field>
        {canManage ? <div className="sm:col-span-2"><Button type="submit" disabled={busy === "config"}>{busy === "config" ? <Loader2Icon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />} ذخیرهٔ تنظیمات</Button></div> : null}
      </form>
    </Card>

    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="بسته‌های اعتبار">
        <div className="space-y-2">{data.packages.length ? data.packages.map((pkg) => <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm" key={pkg.id}><span>{pkg.name}{!pkg.isActive ? " · غیرفعال" : ""}</span><span>{fmt(pkg.creditAmountRial)} اعتبار · {fmt(pkg.priceRial)}</span></div>) : <p className="text-sm text-muted-foreground">هنوز بسته‌ای ساخته نشده است.</p>}</div>
        {canManage ? <form onSubmit={addPackage} className="mt-4 grid gap-2 sm:grid-cols-3"><input className={inputClass} placeholder="نام بسته" value={packageName} onChange={(e) => setPackageName(e.target.value)} required /><PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} placeholder="قیمت ریال" value={packagePrice} onChange={(e) => setPackagePrice(e.target.value)} required /><div className="flex gap-2"><PersianNumberInput className={inputClass} inputMode="numeric" allowDecimal={false} allowNegative={false} placeholder="اعتبار ریال" value={packageCredit} onChange={(e) => setPackageCredit(e.target.value)} required /><Button type="submit" disabled={busy === "package"}>افزودن</Button></div></form> : null}
      </Card>
      <Card title="درخواست‌های شارژ">
        <div className="space-y-2">{data.requests.length ? data.requests.map((request) => <div key={request.id} className="rounded-lg border border-border px-3 py-2 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span>{request.businessName ?? request.businessId} · {request.packageName}</span><b>{request.status === "pending" ? "در انتظار" : request.status === "approved" ? "تأیید شد" : "رد شد"}</b></div><p className="mt-1 text-xs text-muted-foreground">{fmt(request.creditAmountRial)} · {date(request.createdAt)}</p>{canManage && request.status === "pending" ? <div className="mt-2 flex gap-2"><Button className="h-8" onClick={() => void submit({ action: "review_top_up", requestId: request.id, status: "approved" }, `approve:${request.id}`)} disabled={Boolean(busy)}>تأیید</Button><Button className="h-8" variant="danger" onClick={() => void submit({ action: "review_top_up", requestId: request.id, status: "rejected" }, `reject:${request.id}`)} disabled={Boolean(busy)}>رد</Button></div> : null}</div>) : <p className="text-sm text-muted-foreground">درخواستی وجود ندارد.</p>}</div>
      </Card>
    </div>
  </div>;
}
