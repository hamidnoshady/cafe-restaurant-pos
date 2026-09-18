"use client";

/**
 * The WordPress media library as mirrored from the store. Shows attachments
 * (images with thumbnails) synced from the site; the «همگام‌سازی رسانه‌ها»
 * action triggers the same content export (the plugin's export includes
 * attachments). Media upload to the store itself is a later addition — the
 * mirror and the post editor are the common case, and a wrong upload to a
 * live site is irreversible in a way a draft post is not.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, ImageIcon, ExternalLinkIcon } from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";
import { PluginWaitNote } from "./plugin-wait-note";

interface MediaRow {
  remoteId: string;
  title: string;
  mediaUrl: string | null;
  mimeType: string | null;
  remoteUpdatedAt: string | null;
}

export function WpMediaSection() {
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [rows, setRows] = useState<MediaRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  useEffect(() => {
    api<{ connections: ConnectionLite[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else setConnections([]);
    });
  }, []);

  const load = useCallback((connectionId: string) => {
    setRows(null);
    api<{ rows: MediaRow[] }>(
      `/api/integrations/wp-manager/content?connectionId=${connectionId}&type=attachment`,
    ).then((res) => {
      if (res.ok) setRows(res.data.rows);
      else setRows([]);
    });
  }, []);

  useEffect(() => {
    if (selectedId) load(selectedId);
  }, [selectedId, load]);

  async function syncContent() {
    if (!selectedId) return;
    setBusy(true);
    setInfo("");
    const res = await api("/api/integrations/wp-manager/content", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedId }),
    });
    setBusy(false);
    if (!res.ok) setInfo(String(res.data?.error ?? "خطا در همگام‌سازی"));
    else {
      setInfo(res.data?.queued ? "درخواست همگام‌سازی در صف قرار گرفت." : `همگام‌سازی انجام شد (${toPersianDigits(Number(res.data?.total ?? 0))} مورد).`);
      setTimeout(() => load(selectedId), 2500);
    }
  }

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) return <EmptyState>فروشگاهی متصل نیست.</EmptyState>;

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId} />
        <Button variant="outline" size="sm" disabled={busy} onClick={syncContent} className="ms-auto">
          <RefreshCwIcon className="size-4" />
          همگام‌سازی رسانه‌ها
        </Button>
      </div>
      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {info ? <p className="text-xs text-teal-700 dark:text-teal-300">{info}</p> : null}

      {rows === null ? (
        <SectionCardSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <div className={`${cardClass} px-4 py-10 text-center text-sm text-muted-foreground sm:px-5`}>
          رسانه‌ای همگام نشده است. «همگام‌سازی رسانه‌ها» کتابخانهٔ فایل فروشگاه را درخواست می‌کند.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {rows.map((row) => (
            <div key={row.remoteId} className={`${cardClass} overflow-hidden`}>
              <div className="flex aspect-square items-center justify-center overflow-hidden bg-muted">
                {row.mediaUrl && row.mimeType?.startsWith("image/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.mediaUrl} alt={row.title} className="size-full object-cover" loading="lazy" />
                ) : (
                  <ImageIcon className="size-8 text-muted-foreground" />
                )}
              </div>
              <div className="p-3">
                <p className="truncate text-xs font-medium text-foreground">{row.title || `#${row.remoteId}`}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {row.remoteUpdatedAt ? formatJalali(row.remoteUpdatedAt) : ""}
                </p>
                {row.mediaUrl ? (
                  <a
                    href={row.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-teal-700 dark:text-teal-300"
                  >
                    باز کردن فایل
                    <ExternalLinkIcon className="size-3" />
                  </a>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
