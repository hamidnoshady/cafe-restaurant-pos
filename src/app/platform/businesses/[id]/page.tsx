"use client";

/**
 * The workspace overview — what used to be the top of the single 1,000-line
 * business page, rebuilt as a cockpit: identity, headline numbers, the
 * lifecycle switch, and one card per section so the operator picks where to
 * go instead of scrolling to it.
 */
import Link from "next/link";
import { formatPersianNumber } from "@/lib/digits";
import { INDUSTRY_LABELS } from "@/lib/industries";
import { Button, Card, fmtDate, useCapabilities } from "../../ui";
import { useBusiness } from "./context";
import { businessSections } from "./sections";

export default function BusinessOverviewPage() {
  const { business, changeStatus, rootDomain } = useBusiness();
  const caps = useCapabilities();
  if (!business) return null;

  const sections = businessSections(business.id, caps).filter((s) => s.href !== `/platform/businesses/${business.id}`);

  const stats = [
    { label: "سفارش‌ها", value: formatPersianNumber(business.orderCount) },
    { label: "اعضای فعال", value: formatPersianNumber(business.memberCount) },
    { label: "شعبه‌ها", value: formatPersianNumber(business.locationCount) },
  ];

  return (
    <div className="space-y-4">
      <Card title="اطلاعات کلی">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-white/40">نوع کسب‌وکار</dt>
            <dd className="mt-0.5 text-white/80">{INDUSTRY_LABELS[business.industry]}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">منطقهٔ زمانی</dt>
            <dd className="mt-0.5 text-white/80" dir="ltr">
              {business.timezone}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">ایجاد</dt>
            <dd className="mt-0.5 text-white/80">{fmtDate(business.createdAt, true)}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">آخرین فعالیت</dt>
            <dd className="mt-0.5 text-white/80">{fmtDate(business.lastActivityAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">تعلیق در</dt>
            <dd className="mt-0.5 text-white/80">{fmtDate(business.suspendedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-white/40">بایگانی در</dt>
            <dd className="mt-0.5 text-white/80">{fmtDate(business.archivedAt)}</dd>
          </div>
        </dl>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-white/10 bg-white/2 p-3">
              <p className="text-xs text-white/40">{s.label}</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{s.value}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-white/40">
          <Link
            href={`/platform/audit?businessId=${business.id}`}
            className="text-sky-300 hover:underline"
          >
            رویدادهای این کسب‌وکار ←
          </Link>
        </p>
        {rootDomain ? (
          <p className="mt-4 text-xs text-white/40">
            نشانی:{" "}
            <a
              dir="ltr"
              className="text-sky-300 hover:underline"
              href={`https://${business.subdomain}.${rootDomain}`}
              target="_blank"
              rel="noreferrer"
            >
              {business.subdomain}.{rootDomain}
            </a>
          </p>
        ) : null}
      </Card>

      {caps.includes("business.suspend") || caps.includes("business.archive") ? (
        <Card title="چرخهٔ حیات">
          <div className="flex flex-wrap items-center gap-2">
            {business.status === "active" && caps.includes("business.suspend") ? (
              <Button variant="ghost" onClick={() => void changeStatus("suspended", "معلق")}>
                تعلیق
              </Button>
            ) : null}
            {business.status === "suspended" && caps.includes("business.suspend") ? (
              <Button onClick={() => void changeStatus("active", "فعال")}>فعال‌سازی مجدد</Button>
            ) : null}
            {business.status !== "archived" && caps.includes("business.archive") ? (
              <Button variant="ghost" onClick={() => void changeStatus("archived", "بایگانی")}>
                بایگانی
              </Button>
            ) : null}
            {business.status === "archived" && caps.includes("business.suspend") ? (
              <Button onClick={() => void changeStatus("active", "فعال")}>بازگردانی از بایگانی</Button>
            ) : null}
            <span className="text-xs text-white/35">
              تعلیق داده‌ها را پاک نمی‌کند؛ فقط ورود اعضا را می‌بندد.
            </span>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-xl border border-white/10 bg-white/2 p-4 transition-colors hover:border-sky-400/40 hover:bg-white/4"
          >
            <p className="text-sm font-semibold text-sky-300 group-hover:underline">{s.label}</p>
            <p className="mt-1 text-xs leading-5 text-white/40">{s.hint}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
