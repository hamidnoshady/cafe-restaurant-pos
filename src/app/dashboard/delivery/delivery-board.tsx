"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleIcon,
  MapPinIcon,
  PhoneIcon,
  PlusIcon,
  SendIcon,
  UserRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  canTransitionDelivery,
  deliveryStatusLabel,
  type DeliveryStatus,
} from "@/lib/delivery";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, ErrorBox, errorMessage, inputClass } from "../ui";
import { useRealtime } from "../use-realtime";

interface Delivery {
  id: string;
  order_id: string;
  order_number: number;
  order_status: string;
  order_total: string;
  status: DeliveryStatus;
  courier_id: string | null;
  courier_name: string | null;
  address: string;
  phone: string | null;
  fee: string;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  opened_at: string;
}

interface Courier {
  id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
}

const STATUS_META: Record<
  DeliveryStatus,
  { toneClass: string; dotClass: string }
> = {
  pending: {
    toneClass: "border-[#E5E1D8] bg-[#F7F5F0] text-[#625F58]",
    dotClass: "bg-[#8B8780]",
  },
  assigned: {
    toneClass: "border-[#F0D39C] bg-[#FFF7E8] text-[#835500]",
    dotClass: "bg-[#D69217]",
  },
  out_for_delivery: {
    toneClass: "border-[#E7C77B] bg-[#FFF1D8] text-[#7B5100]",
    dotClass: "bg-[#C98209]",
  },
  delivered: {
    toneClass: "border-[#B9E3C8] bg-[#ECF8F0] text-[#1E7041]",
    dotClass: "bg-[#36B56A]",
  },
  failed: {
    toneClass: "border-[#F0C7C1] bg-[#FFF3F1] text-[#9C3328]",
    dotClass: "bg-[#C85449]",
  },
};

function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const meta = STATUS_META[status];

  return (
    <Badge
      variant="outline"
      className={`h-7 gap-1.5 border px-2.5 ${meta.toneClass}`}
      aria-label={deliveryStatusLabel(status)}
    >
      <span
        className={`size-2 rounded-full ${meta.dotClass}`}
        aria-hidden="true"
      />
      {status === "delivered" ? (
        <CheckCircle2Icon className="size-3.5" aria-hidden="true" />
      ) : status === "failed" ? (
        <CircleAlertIcon className="size-3.5" aria-hidden="true" />
      ) : (
        <CircleIcon className="size-3.5" aria-hidden="true" />
      )}
      <span>{deliveryStatusLabel(status)}</span>
    </Badge>
  );
}

function DeliveryQueueSkeleton() {
  return (
    <div
      className="space-y-3"
      aria-busy="true"
      aria-label="در حال دریافت سفارش‌های ارسالی"
    >
      {[0, 1, 2].map((item) => (
        <article
          key={item}
          className="rounded-xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="ops-skeleton h-5 w-28 rounded" />
              <div className="ops-skeleton h-4 w-4/5 rounded" />
              <div className="ops-skeleton h-4 w-28 rounded" />
            </div>
            <div className="space-y-2 text-end">
              <div className="ops-skeleton ms-auto h-7 w-24 rounded-full" />
              <div className="ops-skeleton ms-auto h-5 w-20 rounded" />
            </div>
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="ops-skeleton h-[52px] rounded-lg" />
            <div className="ops-skeleton h-[52px] w-28 rounded-lg" />
          </div>
        </article>
      ))}
    </div>
  );
}

function DeliveryEmptyState() {
  return (
    <section className="rounded-xl border border-dashed border-[#DDD9D1] bg-[#FFFCF7] px-5 py-12 text-center">
      <p className="font-semibold text-[#36342F]">
        سفارش ارسالی فعالی وجود ندارد.
      </p>
      <p className="mt-2 text-sm leading-6 text-[#77756F]">
        با ایجاد یا به‌روزرسانی سفارش‌های ارسالی، صف این بخش خودکار به‌روز
        می‌شود.
      </p>
    </section>
  );
}

function DeliveryCard({
  delivery,
  activeCouriers,
  onAssign,
  onTransition,
}: {
  delivery: Delivery;
  activeCouriers: Courier[];
  onAssign: (deliveryId: string, courierId: string) => void;
  onTransition: (deliveryId: string, status: DeliveryStatus) => void;
}) {
  const isTerminal =
    delivery.status === "delivered" || delivery.status === "failed";
  const canDispatch =
    Boolean(delivery.courier_id) &&
    canTransitionDelivery(delivery.status, "out_for_delivery");
  const canMarkDelivered = canTransitionDelivery(delivery.status, "delivered");
  const canMarkFailed = canTransitionDelivery(delivery.status, "failed");

  return (
    <article className="overflow-hidden rounded-xl border border-[#EAE8E2] bg-white shadow-[0_1px_2px_rgba(37,37,34,0.03)]">
      <div className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-base font-bold text-[#252522]">
              {toPersianDigits(
                formatQueueLabel("delivery", delivery.order_number),
              )}
            </p>
            <div className="mt-2 flex items-start gap-2 text-sm leading-6 text-[#5E5B55]">
              <MapPinIcon
                className="mt-1 size-4 shrink-0 text-[#9A8670]"
                aria-hidden="true"
              />
              <p>{delivery.address}</p>
            </div>
            {delivery.phone ? (
              <p
                className="mt-1 flex items-center gap-2 text-xs text-[#77756F]"
                dir="ltr"
              >
                <PhoneIcon className="size-3.5" aria-hidden="true" />
                {delivery.phone}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-start justify-between gap-4 sm:block sm:text-end">
            <DeliveryStatusBadge status={delivery.status} />
            <div className="text-end sm:mt-2">
              <p className="text-sm font-semibold text-[#36342F]">
                {formatToman(Number(delivery.order_total))}
              </p>
              {Number(delivery.fee) > 0 ? (
                <p className="mt-1 text-xs text-[#77756F]">
                  ارسال: {formatToman(Number(delivery.fee))}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        {delivery.note ? (
          <p className="mt-4 rounded-lg bg-[#FFFCF7] px-3 py-2 text-xs leading-5 text-[#625F58]">
            {delivery.note}
          </p>
        ) : null}

        {isTerminal ? (
          <div className="mt-5 flex min-h-12 items-center gap-2 border-t border-[#F0EFEB] pt-4 text-sm text-[#625F58]">
            <UserRoundIcon
              className="size-4 shrink-0 text-[#9A8670]"
              aria-hidden="true"
            />
            <span>
              {delivery.courier_name
                ? `پیک: ${delivery.courier_name}`
                : "بدون پیک"}
            </span>
          </div>
        ) : (
          <fieldset className="mt-5 border-t border-[#F0EFEB] pt-4">
            <legend className="sr-only">
              عملیات سفارش {toPersianDigits(delivery.order_number)}
            </legend>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
              <div className="min-w-0 flex-1">
                <label
                  className="mb-1.5 block text-xs font-medium text-[#5E5B55]"
                >
                  پیک مسئول
                </label>
                <SearchableSelect
                  ariaLabel="پیک مسئول"
                  className={`${inputClass} min-h-[52px] border-[#DEDAD1] bg-[#FFFEFC] text-[#36342F] focus-visible:border-[#D69217] focus-visible:ring-[#D69217]/25`}
                  value={delivery.courier_id ?? ""}
                  onChange={(value) => onAssign(delivery.id, value)}
                  options={[
                    { value: "", label: "— انتخاب پیک —" },
                    ...activeCouriers.map((courier) => ({ value: courier.id, label: courier.name })),
                  ]}
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row lg:shrink-0">
                {canDispatch ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onTransition(delivery.id, "out_for_delivery")
                    }
                    className="min-h-[52px] border-[#E5C989] bg-[#FFFDF8] px-4 text-[#76500A] hover:bg-[#FFF4DE] focus-visible:border-[#D69217] focus-visible:ring-[#D69217]/25"
                  >
                    <SendIcon className="size-4" aria-hidden="true" />
                    اعزام پیک
                  </Button>
                ) : null}
                {canMarkDelivered ? (
                  <Button
                    type="button"
                    onClick={() => onTransition(delivery.id, "delivered")}
                    className="min-h-[52px] bg-[#D69217] px-4 text-[#2E2106] hover:bg-[#C98209] focus-visible:border-[#B57400] focus-visible:ring-[#D69217]/35"
                  >
                    <CheckCircle2Icon className="size-4" aria-hidden="true" />
                    تحویل شد
                  </Button>
                ) : null}
                {canMarkFailed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => onTransition(delivery.id, "failed")}
                    className="min-h-[52px] px-4 text-[#9C3328] hover:bg-[#FFF3F1] hover:text-[#7E241C] focus-visible:border-[#C85449]/40 focus-visible:ring-[#C85449]/20"
                  >
                    <XCircleIcon className="size-4" aria-hidden="true" />
                    ناموفق
                  </Button>
                ) : null}
              </div>
            </div>
          </fieldset>
        )}
      </div>
    </article>
  );
}

export function DeliveryBoard({
  canManageCouriers,
}: {
  canManageCouriers: boolean;
}) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError("");
    const [deliveriesResponse, couriersResponse] = await Promise.all([
      api<{ deliveries: Delivery[]; error?: string }>(
        `/api/deliveries?includeDone=${includeDone}`,
      ),
      api<{ couriers: Courier[]; error?: string }>(
        `/api/couriers${canManageCouriers ? "?includeInactive=true" : ""}`,
      ),
    ]);

    if (deliveriesResponse.ok)
      setDeliveries(deliveriesResponse.data.deliveries);
    else setError(errorMessage(deliveriesResponse.data.error));

    if (couriersResponse.ok) setCouriers(couriersResponse.data.couriers);
    else setError(errorMessage(couriersResponse.data.error));

    setLoading(false);
  }, [canManageCouriers, includeDone]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime((event) => {
    if (event.type === "order.created" || event.type === "order.updated")
      load();
  });

  const activeCouriers = couriers.filter((courier) => courier.is_active);

  async function patch(id: string, body: Record<string, unknown>) {
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      `/api/deliveries/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
    if (!ok) return setError(errorMessage(data.error));
    load();
  }

  const assign = (id: string, courierId: string) =>
    patch(id, { action: "assign", courierId: courierId || null });
  const transition = (id: string, status: DeliveryStatus) =>
    patch(id, { action: "status", status });

  return (
    <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-6">
      <section aria-labelledby="delivery-queue-heading" className="min-w-0">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2
              id="delivery-queue-heading"
              className="text-lg font-bold text-[#252522]"
            >
              سفارش‌های ارسالی
            </h2>
            <p className="mt-1 text-sm text-[#77756F]">
              تخصیص پیک و پیگیری وضعیت سفارش‌ها
            </p>
          </div>

          <label className="flex min-h-[52px] cursor-pointer items-center justify-between gap-3 rounded-lg border border-[#E5E1D8] bg-[#FFFEFC] px-3 text-sm font-medium text-[#4F4C46] sm:shrink-0">
            <span>نمایش تحویل‌شده‌ها</span>
            <input
              type="checkbox"
              checked={includeDone}
              onChange={(event) => setIncludeDone(event.target.checked)}
              className="size-5 shrink-0 accent-[#D69217]"
            />
          </label>
        </div>

        <ErrorBox>{error}</ErrorBox>

        {loading ? (
          <DeliveryQueueSkeleton />
        ) : deliveries.length === 0 ? (
          <DeliveryEmptyState />
        ) : (
          <ul className="space-y-3" aria-live="polite">
            {deliveries.map((delivery) => (
              <li key={delivery.id}>
                <DeliveryCard
                  delivery={delivery}
                  activeCouriers={activeCouriers}
                  onAssign={assign}
                  onTransition={transition}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManageCouriers ? (
        <CourierPanel couriers={couriers} loading={loading} onChanged={load} />
      ) : null}
    </div>
  );
}

function CourierPanel({
  couriers,
  loading,
  onChanged,
}: {
  couriers: Courier[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    setError("");
    if (!name.trim()) return setError("نام پیک را وارد کنید.");

    setBusy(true);
    const { ok, data } = await api<{ error?: string }>("/api/couriers", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        phone: phone.trim() || undefined,
      }),
    });
    setBusy(false);

    if (!ok) return setError(errorMessage(data.error));
    setName("");
    setPhone("");
    onChanged();
  }

  async function toggle(id: string, isActive: boolean) {
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/couriers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive }),
    });
    if (!ok) return setError(errorMessage(data.error));
    onChanged();
  }

  return (
    <aside
      className="rounded-xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)] md:sticky md:top-6"
      aria-labelledby="couriers-heading"
    >
      <div className="mb-4">
        <h2 id="couriers-heading" className="text-lg font-bold text-[#252522]">
          پیک‌ها
        </h2>
        <p className="mt-1 text-sm text-[#77756F]">مدیریت فهرست پیک‌های شعبه</p>
      </div>

      <ErrorBox>{error}</ErrorBox>

      <form
        className="border-b border-[#F0EFEB] pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div className="space-y-3">
          <div>
            <label
              htmlFor="courier-name"
              className="mb-1.5 block text-xs font-medium text-[#5E5B55]"
            >
              نام پیک
            </label>
            <input
              id="courier-name"
              name="name"
              className={`${inputClass} min-h-[52px] border-[#DEDAD1] bg-[#FFFEFC] text-[#36342F] focus-visible:border-[#D69217] focus-visible:ring-[#D69217]/25`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              required
            />
          </div>
          <div>
            <label
              htmlFor="courier-phone"
              className="mb-1.5 block text-xs font-medium text-[#5E5B55]"
            >
              تلفن (اختیاری)
            </label>
            <input
              id="courier-phone"
              name="phone"
              type="tel"
              inputMode="tel"
              dir="ltr"
              className={`${inputClass} min-h-[52px] border-[#DEDAD1] bg-[#FFFEFC] text-[#36342F] focus-visible:border-[#D69217] focus-visible:ring-[#D69217]/25`}
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoComplete="tel"
            />
          </div>
          <Button
            type="submit"
            disabled={busy}
            className="min-h-[52px] w-full bg-[#D69217] text-[#2E2106] hover:bg-[#C98209] focus-visible:border-[#B57400] focus-visible:ring-[#D69217]/35"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            افزودن پیک
          </Button>
        </div>
      </form>

      <div className="pt-5">
        <h3 className="text-sm font-semibold text-[#4F4C46]">
          پیک‌های ثبت‌شده
        </h3>
        {loading ? (
          <div
            className="mt-3 space-y-2"
            aria-busy="true"
            aria-label="در حال دریافت فهرست پیک‌ها"
          >
            {[0, 1].map((item) => (
              <div
                key={item}
                className="rounded-lg border border-[#F0EFEB] px-3 py-3"
              >
                <div className="ops-skeleton h-4 w-24 rounded" />
              </div>
            ))}
          </div>
        ) : couriers.length === 0 ? (
          <p className="mt-3 rounded-lg bg-[#FFFCF7] px-3 py-4 text-sm leading-6 text-[#77756F]">
            پیکی ثبت نشده است.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {couriers.map((courier) => (
              <li
                key={courier.id}
                className="flex min-h-14 items-center justify-between gap-3 rounded-lg border border-[#F0EFEB] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p
                    className={`truncate text-sm font-medium ${courier.is_active ? "text-[#36342F]" : "text-[#99958D]"}`}
                  >
                    {courier.name}
                  </p>
                  {courier.phone ? (
                    <p
                      className="mt-0.5 truncate text-xs text-[#77756F]"
                      dir="ltr"
                    >
                      {courier.phone}
                    </p>
                  ) : null}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggle(courier.id, !courier.is_active)}
                  aria-pressed={courier.is_active}
                  className={`min-h-[52px] shrink-0 px-3 ${
                    courier.is_active
                      ? "text-[#8B5A00] hover:bg-[#FFF4DE] hover:text-[#6F4600]"
                      : "text-[#1E7041] hover:bg-[#ECF8F0] hover:text-[#155B33]"
                  }`}
                >
                  {courier.is_active ? "غیرفعال" : "فعال"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
