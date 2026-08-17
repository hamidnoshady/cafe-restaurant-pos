"use client";

/**
 * «کلیدهای API» — issuing and revoking the keys that authenticate `/api/v1/*`.
 *
 * Phase 19 built the whole realm: the key format, the SHA-256 storage, the
 * scope guard on every route, the per-key rate-limit bucket. What it never
 * built was a way to *obtain* one, so the public API has been complete and
 * unreachable. This is the missing screen.
 *
 * Two properties are non-negotiable and shape the whole component: the secret
 * is shown exactly once (only its hash is stored, so there is no "show again"
 * to build), and scopes are chosen at issue time rather than derived from the
 * owner's role — a key is a machine credential, not a person.
 */
import { useCallback, useEffect, useState } from "react";
import { useFeatureLocked } from "@/components/feature-lock";
import { api, errorMessage } from "../ui";

interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  status: "active" | "revoked";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * What each scope actually lets a key do, in the owner's language.
 *
 * Worth spelling out rather than showing the raw slug: the person granting
 * these is not the person writing the integration, and "inventory.read" tells
 * them nothing about whether their stock levels are about to leave the
 * building.
 */
const SCOPE_LABELS: Record<string, string> = {
  "orders.read": "خواندن سفارش‌ها",
  "orders.write": "ثبت و تغییر سفارش",
  "menu.read": "خواندن منو و کالاها",
  "menu.write": "تغییر منو و کالاها",
  "inventory.read": "خواندن موجودی انبار",
  "reports.read": "خواندن گزارش‌ها",
  "webhooks.manage": "مدیریت وب‌هوک‌ها",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

export function ApiTokensPanel() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>(["orders.read", "menu.read"]);
  const [expiresInDays, setExpiresInDays] = useState("");

  const load = useCallback(async () => {
    if (locked) {
      setKeys([]);
      setScopes(Object.keys(SCOPE_LABELS));
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{ keys?: ApiKeySummary[]; scopes?: string[] }>("/api/connections/api-keys");
    if (ok) {
      setKeys(data.keys ?? []);
      setScopes(data.scopes ?? Object.keys(SCOPE_LABELS));
    } else {
      setMessage({ kind: "error", text: "بارگذاری کلیدها ممکن نشد." });
    }
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setSelected((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function create() {
    setBusy(true);
    setMessage(null);
    const { ok, data } = await api<{ secret?: string; error?: string }>("/api/connections/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name,
        scopes: selected,
        // Blank means "no expiry", which is a legitimate choice for a
        // long-lived back-office integration — so it is not silently
        // substituted with a default.
        expiresInDays: expiresInDays.trim() ? Number(expiresInDays) : null,
      }),
    });
    setBusy(false);
    if (!ok || !data.secret) {
      const map: Record<string, string> = {
        invalid_name: "برای کلید یک نام وارد کنید.",
        invalid_scopes: "حداقل یک دسترسی را انتخاب کنید.",
        invalid_expiry: "مدت اعتبار معتبر نیست.",
        feature_disabled: "«کلیدهای API» برای کسب‌وکار شما فعال نیست.",
      };
      setMessage({ kind: "error", text: map[data.error ?? ""] ?? errorMessage(data.error) });
      return;
    }
    setSecret(data.secret);
    setName("");
    setExpiresInDays("");
    await load();
  }

  async function revoke(id: string) {
    if (!confirm("این کلید باطل شود؟ برنامه‌هایی که از آن استفاده می‌کنند بلافاصله قطع می‌شوند.")) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/connections/api-keys/${id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setMessage({ kind: "error", text: errorMessage(data.error) || "باطل‌کردن کلید ممکن نشد." });
      return;
    }
    setMessage({ kind: "ok", text: "کلید باطل شد." });
    await load();
  }

  return (
    <div className="space-y-6">
      {message ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {secret ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">این کلید فقط همین یک بار نمایش داده می‌شود.</p>
          <p className="mt-1 text-xs text-amber-800">
            آن را در جای امنی ذخیره کنید. اگر گم شود قابل بازیابی نیست و باید کلید تازه‌ای بسازید.
          </p>
          <code dir="ltr" className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono text-amber-900">
            {secret}
          </code>
          <button
            type="button"
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-xs text-white"
            onClick={() => {
              void navigator.clipboard.writeText(secret).catch(() => undefined);
              setSecret(null);
            }}
          >
            کپی و بستن
          </button>
        </div>
      ) : null}

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-base font-semibold">ساخت کلید جدید</h2>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          هر کلید فقط همان دسترسی‌هایی را دارد که اینجا انتخاب می‌کنید و به شعبهٔ فعال شما محدود است. برای هر
          برنامه یک کلید جدا بسازید تا در صورت نیاز بتوانید فقط همان را باطل کنید.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className="rounded-md border p-2 text-sm"
            placeholder="نام کلید (مثلاً اپلیکیشن باشگاه مشتریان)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="rounded-md border p-2 text-sm"
            dir="ltr"
            type="number"
            min={1}
            placeholder="مدت اعتبار به روز (خالی = بدون انقضا)"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </div>

        <fieldset className="mt-3">
          <legend className="mb-2 text-sm font-medium">دسترسی‌ها</legend>
          <div className="flex flex-wrap gap-2">
            {scopes.map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => toggleScope(scope)}
                className={`rounded-lg border px-3 py-1.5 text-xs ${
                  selected.includes(scope) ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200"
                }`}
              >
                {SCOPE_LABELS[scope] ?? scope}
              </button>
            ))}
          </div>
        </fieldset>

        <button
          className="mt-4 rounded-md bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          onClick={create}
          disabled={busy || !name.trim() || selected.length === 0}
        >
          {busy ? "در حال ساخت…" : "ساخت کلید"}
        </button>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">کلیدهای موجود</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز کلیدی ساخته نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => (
              <li key={key.id} className="rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{key.name}</span>
                  <code dir="ltr" className="rounded bg-stone-100 px-2 py-0.5 font-mono text-xs">
                    {key.keyPrefix}…
                  </code>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      key.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-stone-200 text-stone-600"
                    }`}
                  >
                    {key.status === "active" ? "فعال" : "باطل‌شده"}
                  </span>
                  {key.status === "active" ? (
                    <button
                      className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700"
                      onClick={() => revoke(key.id)}
                      disabled={busy}
                    >
                      باطل‌کردن
                    </button>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {key.scopes.map((scope) => (
                    <span key={scope} className="rounded bg-stone-100 px-2 py-0.5">
                      {SCOPE_LABELS[scope] ?? scope}
                    </span>
                  ))}
                </div>
                <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>ساخت: {formatDateTime(key.createdAt)}</span>
                  <span>آخرین استفاده: {formatDateTime(key.lastUsedAt)}</span>
                  <span>انقضا: {key.expiresAt ? formatDateTime(key.expiresAt) : "ندارد"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-base font-semibold">راهنمای استفاده</h2>
        <p className="mb-2 text-xs leading-6 text-muted-foreground">
          کلید را در سرآیند <code dir="ltr">Authorization</code> بفرستید. آدرس پایه، همین دامنه است.
        </p>
        <pre dir="ltr" className="overflow-x-auto rounded-lg bg-stone-900 p-3 text-xs text-stone-100">
{`curl -H "Authorization: Bearer posk_live_..." \\
     ${typeof window !== "undefined" ? window.location.origin : "https://your-domain"}/api/v1/orders`}
        </pre>
      </section>
    </div>
  );
}
