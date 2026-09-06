"use client";

/**
 * One honest note about what «همگام‌سازی» does in plugin mode: the app
 * enqueues a job and the WordPress plugin applies/answers on its next pull
 * (normally within five minutes), rather than the data appearing instantly
 * the way it does in REST mode. Shown once per section instead of pretending
 * the button did nothing.
 */
import { InfoIcon } from "lucide-react";

interface ConnectionLike {
  id: string;
  linkMode: "rest_api" | "plugin";
}

export function PluginWaitNote({
  connections,
  selectedId,
}: {
  connections: ConnectionLike[];
  selectedId: string;
}) {
  const selected = connections.find((c) => c.id === selectedId);
  if (!selected || selected.linkMode !== "plugin") return null;
  return (
    <p className="flex items-start gap-2 rounded-xl bg-teal-50 px-4 py-3 text-xs leading-5 text-teal-900 dark:bg-teal-500/10 dark:text-teal-200">
      <InfoIcon className="mt-0.5 size-4 shrink-0" />
      در حالت اتصال با افزونه، «همگام‌سازی» یک درخواست در صف قرار می‌دهد و افزونهٔ وردپرس آن را در اجرای بعدی
      (معمولاً ظرف چند دقیقه) پاسخ می‌دهد. داده‌ها بلافاصله پس از رسیدن از فروشگاه اینجا نمایش داده می‌شوند.
    </p>
  );
}
