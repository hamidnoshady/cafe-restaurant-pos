"use client";

/**
 * «پیوند بخش‌ها» tab — the migration-0117 half of the knowledge base.
 *
 * One external learning page (a URL) per dashboard section, opened by the
 * «آموزش» icon in a modal; the in-product guides (migration 0131) live in the
 * other three tabs of this page. The list is the section catalogue itself
 * (src/lib/knowledge-base.ts), so a section that is not visible to a business
 * simply has no page to learn from.
 *
 * Reads are open to every admin (labels and public URLs); writes need
 * `knowledge.manage` (engineer, owner) — same split as the prompt manager.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLinkIcon, PencilIcon, SearchIcon } from "lucide-react";
import {
  api,
  Button,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  fmtDate,
  inputClass,
  useCan,
} from "../ui";

interface SectionRow {
  section: string;
  label: string;
  route: string;
  url: string | null;
  is_active: boolean;
  notes: string;
  updated_at: string | null;
}

export function SectionsPanel() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [rows, setRows] = useState<SectionRow[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");

  const [editing, setEditing] = useState<SectionRow | null>(null);
  const [url, setUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ sections: SectionRow[]; error?: string }>(
      "/api/platform/knowledge",
    );
    if (ok) {
      setRows(data.sections);
      setError("");
    } else {
      setError(data.error === "forbidden" ? "دسترسی شما برای این صفحه کافی نیست." : "خطای غیرمنتظره. دوباره تلاش کنید.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.section.toLowerCase().includes(q) ||
        r.route.toLowerCase().includes(q) ||
        (r.url ?? "").toLowerCase().includes(q),
    );
  }, [rows, filter]);

  function openEditor(row: SectionRow) {
    setEditing(row);
    setUrl(row.url ?? "");
    setNotes(row.notes);
    setIsActive(row.is_active);
    setFormError("");
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError("");
    const { ok, data } = await api<{ error?: string }>("/api/platform/knowledge", {
      method: "PUT",
      body: JSON.stringify({
        section: editing.section,
        url,
        is_active: isActive,
        notes,
      }),
    });
    setBusy(false);
    if (!ok) {
      setFormError(
        data.error === "invalid_url"
          ? "آدرس باید با http:// یا https:// شروع شود."
          : data.error === "unknown_section"
            ? "این بخش در فهرست بخش‌ها نیست."
            : "خطای غیرمنتظره. دوباره تلاش کنید.",
      );
      return;
    }
    setEditing(null);
    void load();
  }

  async function toggleActive(row: SectionRow) {
    if (!row.url) return;
    setBusy(true);
    if (row.is_active) {
      await api(`/api/platform/knowledge?section=${encodeURIComponent(row.section)}`, {
        method: "DELETE",
      });
    } else {
      // Re-activate the stored URL by re-saving it.
      await api("/api/platform/knowledge", {
        method: "PUT",
        body: JSON.stringify({
          section: row.section,
          url: row.url,
          is_active: true,
          notes: row.notes,
        }),
      });
    }
    setBusy(false);
    void load();
  }

  const configured = rows?.filter((r) => r.url).length ?? 0;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <InfoBox>
        {canManage
          ? `روی «ویرایش» یک بخش بزنید و آدرس صفحهٔ آموزشی ساخته‌شده برای همان بخش را بچسبانید. ${configured ? `${configured} بخش دارای صفحهٔ آموزشی است.` : "هنوز صفحه‌ای ثبت نشده است."}`
          : "شما فقط می‌توانید فهرست بخش‌ها و صفحات ثبت‌شده را ببینید؛ ثبت و تغییر آدرس‌ها در اختیار مهندس و مدیر ارشد است."}
      </InfoBox>

      <ErrorBox>{error}</ErrorBox>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-white/30"
          />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="جست‌وجو در بخش‌ها…"
            className={`${inputClass} ps-9`}
          />
        </div>
        <span className="shrink-0 text-xs text-white/40">
          {rows ? `${visible?.length ?? 0} از ${rows.length} بخش` : "…"}
        </span>
      </div>

      {rows === null ? (
        <SkeletonRows rows={6} />
      ) : visible && visible.length === 0 ? (
        <EmptyState title="بخشی پیدا نشد" hint="عبارت جست‌وجو را تغییر دهید." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="min-w-[760px] w-full text-sm">
            <thead className="bg-white/3 text-white/50">
              <tr>
                <th className="px-4 py-3 text-start font-medium">بخش</th>
                <th className="px-4 py-3 text-start font-medium">صفحهٔ آموزشی</th>
                <th className="px-4 py-3 text-start font-medium">وضعیت</th>
                <th className="px-4 py-3 text-start font-medium">به‌روزرسانی</th>
                {canManage ? <th className="px-4 py-3 text-start font-medium">عملیات</th> : null}
              </tr>
            </thead>
            <tbody>
              {(visible ?? []).map((row) => (
                <tr key={row.section} className="border-t border-white/5 align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-white/90">{row.label}</p>
                    <p className="mt-0.5 text-[11px] text-white/35" dir="ltr">
                      {row.route}
                    </p>
                  </td>
                  <td className="max-w-[280px] px-4 py-3">
                    {row.url ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1.5 text-sky-300 transition-colors hover:text-sky-200"
                        dir="ltr"
                      >
                        <span className="truncate">{row.url}</span>
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      </a>
                    ) : (
                      <span className="text-white/35">ثبت نشده</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {row.url ? (
                      row.is_active ? (
                        <span className="inline-block rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                          فعال
                        </span>
                      ) : (
                        <span className="inline-block rounded-full border border-white/20 bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/50">
                          غیرفعال
                        </span>
                      )
                    ) : (
                      <span className="text-white/35">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/50">{fmtDate(row.updated_at)}</td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => openEditor(row)}>
                          <span className="inline-flex items-center gap-1.5">
                            <PencilIcon className="size-3.5" aria-hidden="true" />
                            ویرایش
                          </span>
                        </Button>
                        {row.url ? (
                          <Button
                            variant="ghost"
                            className="h-8 px-3 text-xs"
                            disabled={busy}
                            onClick={() => void toggleActive(row)}
                          >
                            {row.is_active ? "غیرفعال‌کردن" : "فعال‌کردن"}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor — the console's own modal language (dark, one card, no portal kit). */}
      {editing ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`آموزش ${editing.label}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <div className="w-full max-w-lg rounded-xl border border-white/10 bg-slate-900 p-5 shadow-2xl">
            <h2 className="text-base font-bold text-white">
              {editing.url ? "ویرایش" : "ثبت"} صفحهٔ آموزشی: {editing.label}
            </h2>
            <p className="mt-1 text-xs text-white/40" dir="ltr">
              {editing.route}
            </p>

            <div className="mt-5">
              <Field
                label="آدرس صفحهٔ آموزشی"
                hint="با http:// یا https/ شروع شود؛ صفحه در پنجرهٔ پاپ‌آپِ دکمهٔ «آموزش» بارگذاری می‌شود."
              >
                <input
                  type="url"
                  dir="ltr"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://help.example.com/pos"
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="توضیح (اختیاری)">
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="مثلاً راهنمای کامل ثبت سفارش"
                  className={inputClass}
                  maxLength={2000}
                />
              </Field>
              <label className="mb-4 flex cursor-pointer items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="size-4 accent-sky-500"
                />
                این صفحه برای کارکنان فعال باشد
              </label>

              {formError ? <ErrorBox>{formError}</ErrorBox> : null}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  انصراف
                </Button>
                <Button onClick={() => void save()} disabled={busy || !url.trim()}>
                  {busy ? "در حال ذخیره…" : "ذخیره"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
