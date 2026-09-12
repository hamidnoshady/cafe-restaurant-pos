"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { MessageCircleIcon, PlusIcon, SendIcon, WalletCardsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

type Channel = "sms" | "email";
interface Template { id: string; channel: Channel; name: string; subject: string; body: string }
interface Segment { id: string; name: string; description: string }
interface Project { id: string; name: string }
interface Promotion { id: string; name: string; isActive: boolean }
interface Campaign { id: string; channel: Channel; name: string; templateId: string | null; segmentId: string | null; projectId: string | null; promotionId: string | null; status: string; totalRecipients: number; sentCount: number; deliveredCount: number; failedCount: number; createdAt: string }
interface CreditPackage { id: string; name: string; priceRial: number; creditAmountRial: number }
interface Ledger { id: string; kind: string; amountRial: number; actualCostRial: number | null; note: string | null; createdAt: string }
interface Data {
  config: { enabled: boolean; configured: boolean; rate: { smsRialPerSegment: number; emailRialPerSend: number } };
  billing: { balanceRial: number };
  packages: CreditPackage[]; ledger: Ledger[]; templates: Template[]; campaigns: Campaign[]; segments: Segment[]; projects: Project[]; promotions: Promotion[];
}
interface Audience { matched: number; reachable: number; excluded: number; missingContact: number }
interface MessagePreview { customerName: string; channel: Channel; subject: string; body: string; smsSegments: number | null; costRial: number; matched: number; reachable: number; excluded: number }

const rial = (amount: number) => `${formatPersianNumber(amount)} ریال`;
const channelLabel: Record<Channel, string> = { sms: "پیامک", email: "ایمیل" };
const status = (state: string) => state === "sending" ? "در حال ارسال" : state === "completed" ? "تکمیل‌شده" : state === "paused" ? "متوقف" : "پیش‌نویس";

/** Campaign composer and message-credit statement; the actual recipient filter remains server-side in CRM. */
export function MessagingSection() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [templateChannel, setTemplateChannel] = useState<Channel>("sms");
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignChannel, setCampaignChannel] = useState<Channel>("sms");
  const [templateId, setTemplateId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [promotionId, setPromotionId] = useState("");
  const [audience, setAudience] = useState<Audience | null>(null);
  const [messagePreview, setMessagePreview] = useState<MessagePreview | null>(null);

  const load = useCallback(async () => {
    const result = await api<Data & { error?: string }>("/api/messaging");
    if (!result.ok) { setError(result.data.error ?? "دریافت اطلاعات پیام‌رسانی ممکن نشد."); return; }
    setData(result.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const matchingTemplates = useMemo(() => data?.templates.filter((item) => item.channel === campaignChannel) ?? [], [data, campaignChannel]);
  useEffect(() => { if (!matchingTemplates.some((item) => item.id === templateId)) setTemplateId(matchingTemplates[0]?.id ?? ""); }, [matchingTemplates, templateId]);

  async function send(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(""); setNotice("");
    const result = await api<{ error?: string }>("/api/messaging", { method: "POST", body: JSON.stringify(body) });
    setBusy("");
    if (!result.ok) { setError(result.data.error ?? "عملیات پیام‌رسانی ناموفق بود."); return false; }
    await load();
    return true;
  }

  async function previewAudience(nextSegment = segmentId, nextChannel = campaignChannel) {
    if (!nextSegment) { setAudience(null); return; }
    setError("");
    const result = await api<{ audience?: Audience; error?: string }>("/api/growth/campaign-audience", { method: "POST", body: JSON.stringify({ segmentId: nextSegment, channel: nextChannel }) });
    if (!result.ok || !result.data.audience) { setError(result.data.error ?? "پیش‌نمایش مخاطب ممکن نشد."); return; }
    setAudience(result.data.audience);
  }

  async function previewMessage() {
    if (!templateId || !segmentId) return;
    setBusy("preview"); setError(""); setMessagePreview(null);
    const result = await api<{ preview?: MessagePreview; error?: string }>("/api/messaging/preview", {
      method: "POST", body: JSON.stringify({ templateId, segmentId }),
    });
    setBusy("");
    if (!result.ok || !result.data.preview) { setError(result.data.error ?? "پیش‌نمایش متن ممکن نشد."); return; }
    setMessagePreview(result.data.preview);
  }

  async function addTemplate(event: FormEvent) {
    event.preventDefault();
    const saved = await send({ action: "template", channel: templateChannel, name: templateName, subject: templateSubject, message: templateBody }, "template");
    if (saved) { setTemplateName(""); setTemplateSubject(""); setTemplateBody(""); setNotice("الگو ذخیره شد."); }
  }
  async function addCampaign(event: FormEvent) {
    event.preventDefault();
    const saved = await send({ action: "campaign", channel: campaignChannel, name: campaignName, templateId, segmentId, projectId: projectId || null, promotionId: promotionId || null }, "campaign");
    if (saved) { setCampaignName(""); setNotice("پیش‌نویس کمپین ساخته شد. پس از بررسی پیش‌نمایش، ارسال را شروع کنید."); }
  }
  async function startCampaign(id: string) {
    const saved = await send({ action: "launch", campaignId: id }, `launch:${id}`);
    if (saved) setNotice("مخاطبانِ دارای رضایت در صف ارسال قرار گرفتند.");
  }
  async function requestTopUp(packageId: string) {
    const saved = await send({ action: "top_up", packageId }, `topup:${packageId}`);
    if (saved) setNotice("درخواست شارژ برای تأیید پلتفرم ثبت شد.");
  }

  if (!data) return <SectionCardSkeleton rows={7} />;
  const costPerRecipient = campaignChannel === "sms" ? data.config.rate.smsRialPerSegment : data.config.rate.emailRialPerSend;

  return <div className="space-y-4 sm:space-y-5">
    <ErrorBox>{error}</ErrorBox>{notice ? <InfoBox>{notice}</InfoBox> : null}
    <section className="grid gap-3 md:grid-cols-3">
      <div className={`${cardClass} p-4`}><WalletCardsIcon className="size-5 text-amber-600 dark:text-amber-400" /><p className="mt-2 text-xs text-muted-foreground">مانده اعتبار پیام</p><b className="text-lg">{rial(data.billing.balanceRial)}</b></div>
      <div className={`${cardClass} p-4`}><MessageCircleIcon className="size-5 text-amber-600 dark:text-amber-400" /><p className="mt-2 text-xs text-muted-foreground">وضعیت ارائه‌دهنده</p><b className="text-sm">{data.config.enabled && data.config.configured ? "آمادهٔ ارسال" : "نیازمند تنظیم پلتفرم"}</b></div>
      <div className={`${cardClass} p-4`}><SendIcon className="size-5 text-amber-600 dark:text-amber-400" /><p className="mt-2 text-xs text-muted-foreground">نرخ فعلی</p><b className="text-sm">پیامک {rial(data.config.rate.smsRialPerSegment)} · ایمیل {rial(data.config.rate.emailRialPerSend)}</b></div>
    </section>

    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard title="الگوی پیام" description="متغیرهای قابل استفاده: {{نام}}، {{نام_فروشگاه}}، {{امتیاز}}، {{اعتبار}} و {{کد_تخفیف}}.">
        <form className="grid gap-3" onSubmit={addTemplate}>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="کانال"><select className={inputClass} value={templateChannel} onChange={(e) => setTemplateChannel(e.target.value as Channel)}><option value="sms">پیامک</option><option value="email">ایمیل</option></select></Field><Field label="نام الگو"><input className={inputClass} value={templateName} onChange={(e) => setTemplateName(e.target.value)} required /></Field></div>
          {templateChannel === "email" ? <Field label="موضوع ایمیل"><input className={inputClass} value={templateSubject} onChange={(e) => setTemplateSubject(e.target.value)} /></Field> : null}
          <Field label="متن پیام"><textarea className={`${inputClass} min-h-28`} value={templateBody} onChange={(e) => setTemplateBody(e.target.value)} required /></Field>
          <div><Button type="submit" disabled={busy === "template"}>{busy === "template" ? "در حال ذخیره…" : <><PlusIcon /> ذخیرهٔ الگو</>}</Button></div>
        </form>
        <div className="mt-4 space-y-1">{data.templates.length ? data.templates.map((item) => <div className="rounded-lg border border-border/80 px-3 py-2 text-sm" key={item.id}><b>{item.name}</b><span className="mr-2 text-xs text-muted-foreground">{channelLabel[item.channel]}</span><p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{item.body}</p></div>) : <EmptyState>هنوز الگویی ندارید.</EmptyState>}</div>
      </SectionCard>

      <SectionCard title="ساخت و پیش‌نمایش کمپین" description="قبل از صف‌کردن ارسال، تعداد مخاطبانِ با رضایت و هزینهٔ تخمینی را بررسی کنید.">
        <form className="grid gap-3" onSubmit={addCampaign}>
          <Field label="نام کمپین"><input className={inputClass} value={campaignName} onChange={(e) => setCampaignName(e.target.value)} required /></Field>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="کانال"><select className={inputClass} value={campaignChannel} onChange={(e) => { const value = e.target.value as Channel; setCampaignChannel(value); void previewAudience(segmentId, value); }}><option value="sms">پیامک</option><option value="email">ایمیل</option></select></Field><Field label="الگو"><select className={inputClass} value={templateId} onChange={(e) => setTemplateId(e.target.value)} required><option value="">انتخاب الگو</option>{matchingTemplates.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>
          <div className="grid gap-3 sm:grid-cols-2"><Field label="بخش مشتریان"><select className={inputClass} value={segmentId} onChange={(e) => { setSegmentId(e.target.value); void previewAudience(e.target.value); }} required><option value="">انتخاب بخش</option>{data.segments.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field><Field label="پروژه / مرکز هزینه (اختیاری)"><select className={inputClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">بدون پروژه</option>{data.projects.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div><Field label="پروموشنِ اختصاصی برای سنجش بازده (اختیاری)" hint="فقط فروش‌های ثبت‌شده با همین پروموشن به این کمپین نسبت داده می‌شوند؛ بدون آن، بازده قابل محاسبه نیست."><select className={inputClass} value={promotionId} onChange={(e) => setPromotionId(e.target.value)}><option value="">بدون پروموشن اختصاصی</option>{data.promotions.filter((item) => item.isActive).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
          {audience ? <div className="rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/25"><p><b>{formatPersianNumber(audience.reachable)}</b> مخاطب قابل‌ارسال از {formatPersianNumber(audience.matched)} عضو بخش</p><p className="mt-1 text-xs text-muted-foreground">{formatPersianNumber(audience.excluded)} نفر فاقد رضایت یا راه ارتباطی · هزینهٔ برآوردی: {rial(audience.reachable * costPerRecipient)}</p></div> : <p className="text-xs text-muted-foreground">بخش مشتریان را انتخاب کنید تا پیش‌نمایش با قواعد رضایت انجام شود.</p>}
          {messagePreview ? <div className="rounded-lg border border-border/80 p-3 text-sm"><p className="font-medium">نمونه با دادهٔ واقعیِ «{messagePreview.customerName}»</p>{messagePreview.subject ? <p className="mt-1 text-xs text-muted-foreground">موضوع: {messagePreview.subject}</p> : null}<p className="mt-2 whitespace-pre-wrap">{messagePreview.body}</p><p className="mt-2 text-xs text-muted-foreground">{messagePreview.smsSegments === null ? "ایمیل" : `${formatPersianNumber(messagePreview.smsSegments)} قطعه پیامک`} · هزینهٔ این نمونه {rial(messagePreview.costRial)}</p></div> : null}
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={!templateId || !segmentId || busy === "preview"} onClick={() => void previewMessage()}>{busy === "preview" ? "در حال آماده‌سازی…" : <><MessageCircleIcon /> نمایش نمونهٔ واقعی</>}</Button><Button type="submit" disabled={!templateId || !segmentId || busy === "campaign"}>{busy === "campaign" ? "در حال ساخت…" : <><PlusIcon /> ساخت پیش‌نویس</>}</Button></div>
        </form>
      </SectionCard>
    </div>

    <SectionCard title="کمپین‌های پیام" description="با شروع ارسال، مخاطبانِ دارای رضایت همان لحظه ثابت و در صف خروجی ثبت می‌شوند.">
      {data.campaigns.length ? <ul className="divide-y divide-border/80">{data.campaigns.map((campaign) => <li key={campaign.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-medium">{campaign.name} <StatusBadge tone={campaign.status === "sending" ? "active" : campaign.status === "paused" ? "neutral" : "positive"}>{status(campaign.status)}</StatusBadge></p><p className="mt-1 text-xs text-muted-foreground">{channelLabel[campaign.channel]} · {formatPersianNumber(campaign.sentCount)} ارسال‌شده از {formatPersianNumber(campaign.totalRecipients)} · تحویل {formatPersianNumber(campaign.deliveredCount)} · ناموفق {formatPersianNumber(campaign.failedCount)} · {campaign.promotionId ? "بازده با پروموشن اختصاصی در گزارش حسابداری" : "بازده: قابل محاسبه نیست (پروموشن اختصاصی ندارد)"}</p></div>{campaign.status === "draft" ? <Button size="sm" disabled={busy === `launch:${campaign.id}`} onClick={() => void startCampaign(campaign.id)}>{busy === `launch:${campaign.id}` ? "در حال شروع…" : <><SendIcon /> شروع ارسال</>}</Button> : campaign.status === "sending" ? <Button variant="outline" size="sm" disabled={busy === `pause:${campaign.id}`} onClick={() => void send({ action: "pause", campaignId: campaign.id }, `pause:${campaign.id}`)}>توقف</Button> : campaign.status === "paused" ? <Button variant="outline" size="sm" disabled={busy === `resume:${campaign.id}`} onClick={() => void send({ action: "resume", campaignId: campaign.id }, `resume:${campaign.id}`)}>{busy === `resume:${campaign.id}` ? "در حال ادامه…" : "ادامهٔ ارسال"}</Button> : null}</li>)}</ul> : <EmptyState>هنوز پیش‌نویس یا کمپین پیامی ثبت نشده است.</EmptyState>}
    </SectionCard>

    <div className="grid gap-4 xl:grid-cols-2"><SectionCard title="خرید اعتبار" description="بسته را انتخاب کنید؛ مبلغ و اعتبار آن در درخواست شما ثابت می‌شود."><div className="space-y-2">{data.packages.length ? data.packages.map((pkg) => <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 p-3" key={pkg.id}><div><b>{pkg.name}</b><p className="text-xs text-muted-foreground">{rial(pkg.creditAmountRial)} اعتبار در برابر {rial(pkg.priceRial)}</p></div><Button variant="outline" size="sm" disabled={busy === `topup:${pkg.id}`} onClick={() => void requestTopUp(pkg.id)}>درخواست شارژ</Button></div>) : <EmptyState>بستهٔ فعالی از سوی پلتفرم تعریف نشده است.</EmptyState>}</div></SectionCard><SectionCard title="گردش اعتبار اخیر"><div className="space-y-2">{data.ledger.length ? data.ledger.map((row) => <div className="flex items-center justify-between text-sm" key={row.id}><span>{row.note ?? row.kind}</span><b className={row.amountRial >= 0 ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}>{row.amountRial >= 0 ? "+" : ""}{rial(row.amountRial)}</b></div>) : <EmptyState>هنوز گردش اعتباری ثبت نشده است.</EmptyState>}</div></SectionCard></div>
  </div>;
}
