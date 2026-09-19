"use client";

/**
 * WordPress content management: posts and pages mirrored from the site, with
 * create/edit actions. Plugin mode enqueues a `post_upsert` outbox job (the
 * plugin applies it on its next pull); REST mode writes wp/v2 directly.
 *
 * Editing rule the editor enforces: `content` is only ever sent when the
 * mirror handed us the post's *raw* content and the member changed it. The
 * old editor always sent `content: ""`, and both wp/v2 and the plugin apply
 * that literally — saving a typo in a title wiped the live post's body.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/app/dashboard/ui";
import { api, errorMessageOrRaw } from "@/app/dashboard/ui";
import { RefreshCwIcon, FileTextIcon, PlusIcon, ExternalLinkIcon, PencilIcon } from "lucide-react";
import { useFeatureLocked } from "@/components/feature-lock";
import { cardClass, EmptyState, SectionCardSkeleton, StatusBadge, TabBar } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";
import { PluginWaitNote } from "./plugin-wait-note";

interface ContentRow {
  remoteId: string;
  wpType: string;
  title: string;
  slug: string;
  status: string;
  permalink: string;
  authorName: string;
  mediaUrl: string | null;
  mimeType: string | null;
  /** Raw post HTML when the mirror carries it; null when it does not. */
  content: string | null;
  remoteUpdatedAt: string | null;
  syncedAt: string;
}

type ContentTab = "post" | "page";

export function WpContentSection() {
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<ContentTab>("post");
  const [rows, setRows] = useState<ContentRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ContentRow | "new" | null>(null);
  const locked = useFeatureLocked();

  useEffect(() => {
    // Locked preview: /api/integrations/* answers `feature_disabled`, so asking
    // would only light the console with 403s behind the grayed-out preview.
    if (locked) {
      setConnections([]);
      return;
    }
    api<{ connections: ConnectionLite[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else setConnections([]);
    });
  }, [locked]);

  const load = useCallback(
    (connectionId: string, type: string) => {
      setRows(null);
      api<{ rows: ContentRow[] }>(
        `/api/integrations/wp-manager/content?connectionId=${connectionId}&type=${type}`,
      ).then((res) => {
        if (res.ok) setRows(res.data.rows);
        else setRows([]);
      });
    },
    [],
  );

  useEffect(() => {
    if (selectedId) load(selectedId, tab);
  }, [selectedId, tab, load]);

  async function syncContent() {
    if (!selectedId) return;
    setBusy(true);
    setInfo("");
    setError("");
    const res = await api("/api/integrations/wp-manager/content", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedId }),
    });
    setBusy(false);
    if (!res.ok) setError(errorMessageOrRaw(String(res.data?.error ?? "")) || "خطا در همگام‌سازی");
    else {
      setInfo(res.data?.queued ? "درخواست همگام‌سازی محتوا در صف قرار گرفت؛ با اجرای بعدی افزونه می‌رسد." : `همگام‌سازی انجام شد (${toPersianDigits(Number(res.data?.total ?? 0))} مورد).`);
      setTimeout(() => load(selectedId, tab), 2500);
    }
  }

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) return <EmptyState>فروشگاهی متصل نیست.</EmptyState>;

  const statusLabel: Record<string, string> = {
    publish: "منتشرشده",
    draft: "پیش‌نویس",
    pending: "در انتظار",
    private: "خصوصی",
    future: "زمان‌بندی‌شده",
    trash: "زباله‌دان",
  };

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        <Button variant="outline" size="sm" disabled={busy} onClick={syncContent} className="ms-auto">
          <RefreshCwIcon className="size-4" />
          {busy ? "در حال همگام‌سازی…" : "همگام‌سازی محتوا"}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setEditing("new")}>
          <PlusIcon className="size-4" />
          {tab === "post" ? "نوشتهٔ تازه" : "برگهٔ تازه"}
        </Button>
      </div>
      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {info ? <p className="text-xs text-teal-700 dark:text-teal-300">{info}</p> : null}
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}

      <TabBar
        idPrefix="wp-content"
        label="نوع محتوا"
        tabs={[
          { key: "post", label: "نوشته‌ها" },
          { key: "page", label: "برگه‌ها" },
        ]}
        active={tab}
        onChange={setTab}
      />

      <section className={`${cardClass} overflow-hidden`}>
        {rows === null ? (
          <SectionCardSkeleton rows={4} />
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
            محتوایی همگام نشده است. «همگام‌سازی محتوا» را بزنید.
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {rows.map((row) => (
              <li key={row.remoteId} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <FileTextIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{row.title || `#${row.remoteId}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.authorName ? `${row.authorName} • ` : ""}
                    {row.remoteUpdatedAt ? formatJalali(row.remoteUpdatedAt, { withTime: true }) : ""}
                  </p>
                </div>
                <StatusBadge tone={row.status === "publish" ? "positive" : "neutral"}>
                  {statusLabel[row.status] ?? row.status}
                </StatusBadge>
                {row.permalink ? (
                  <a
                    href={row.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                  >
                    مشاهده
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => setEditing(row)}>
                  <PencilIcon className="size-3.5" />
                  ویرایش
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <PostEditor
          connectionId={selectedId}
          type={tab}
          row={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setInfo("درخواست ذخیره در صف قرار گرفت؛ پس از اعمال توسط فروشگاه، همگام‌سازی کنید.");
            // REST mode applies immediately, and even the queued path updates
            // the mirror's title/status — a stale list right after «ذخیره»
            // read as "the save did nothing".
            if (selectedId) load(selectedId, tab);
          }}
        />
      ) : null}
    </div>
  );
}

function PostEditor({
  connectionId,
  type,
  row,
  onClose,
  onSaved,
}: {
  connectionId: string;
  type: ContentTab;
  row: ContentRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(row?.title ?? "");
  const [content, setContent] = useState(row?.content ?? "");
  const [contentDirty, setContentDirty] = useState(false);
  const [status, setStatus] = useState(row?.status ?? "draft");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    const res = await api("/api/integrations/wp-manager/content/posts", {
      method: "POST",
      body: JSON.stringify({
        connectionId,
        post_type: type,
        ...(row ? { id: Number(row.remoteId) } : {}),
        title,
        // Only when the member actually changed it — an untouched editor must
        // never rewrite the live post's body, and a mirror that never carried
        // the raw content cannot round-trip it at all.
        ...(contentDirty ? { content } : {}),
        status,
      }),
    });
    setBusy(false);
    if (!res.ok) setError(errorMessageOrRaw(String(res.data?.error ?? "")) || "ذخیره با خطا مواجه شد");
    else onSaved();
  }

  const contentEditable = !row || row.content !== null;

  return (
    <div className={`${cardClass} p-4 sm:p-5`}>
      <h3 className="mb-4 font-semibold text-foreground">
        {row ? `ویرایش: ${row.title || `#${row.remoteId}`}` : type === "post" ? "نوشتهٔ تازه" : "برگهٔ تازه"}
      </h3>
      <div className="space-y-3">
        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field
          label="محتوا (HTML وردپرس)"
          hint={
            row && !contentEditable
              ? "محتوای فعلی این نوشته از فروشگاه خوانده نشده است؛ برای ویرایش محتوا ابتدا «همگام‌سازی محتوا» را بزنید. عنوان و وضعیت همین حالا قابل تغییرند."
              : undefined
          }
        >
          <textarea
            className={`${inputClass} min-h-[200px] leading-7`}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setContentDirty(true);
            }}
            disabled={!contentEditable}
            placeholder={contentEditable ? "متن نوشته یا برگه…" : ""}
          />
        </Field>
        <Field label="وضعیت">
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="draft">پیش‌نویس</option>
            <option value="publish">منتشرشده</option>
            <option value="pending">در انتظار بررسی</option>
            <option value="private">خصوصی</option>
          </select>
        </Field>
        {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        <div className="flex gap-2">
          <Button disabled={busy || !title.trim()} onClick={save}>
            {busy ? "در حال ارسال…" : "ذخیره در فروشگاه"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            انصراف
          </Button>
        </div>
        <p className="text-[11px] leading-5 text-muted-foreground">
          {row
            ? contentDirty
              ? "محتوای ویرایش‌شده همراه عنوان و وضعیت ذخیره می‌شود."
              : "محتوا دست نخورده باقی می‌ماند؛ فقط عنوان و وضعیت ذخیره می‌شوند."
            : "در حالت افزونه، ذخیره به‌صورت یک کار در صف قرار می‌گیرد و افزونه در اجرای بعدی آن را اعمال می‌کند."}
        </p>
      </div>
    </div>
  );
}
