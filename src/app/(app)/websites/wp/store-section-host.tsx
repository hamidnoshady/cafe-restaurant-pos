"use client";

/**
 * Host for the existing WooCommerce store sections
 * (CatalogueSection / StoreOrdersSection / TaxonomiesSection) inside the WP
 * Manager app: pick a connection, then render the section against it. Those
 * components accept a `connectionId` prop so every WP Manager surface can use
 * the same selected store; the connection is chosen once here.
 */
import { useCallback, useState } from "react";
import Link from "next/link";
import { PlugIcon } from "lucide-react";
import { api, ErrorBox, errorMessageOrRaw } from "@/app/dashboard/ui";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { CatalogueSection, StoreOrdersSection } from "./woo-store-sections";
import { TaxonomiesSection } from "./taxonomies-section";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker } from "./connection-lite";
import { useWpStore, type WpManagerConnection as Connection } from "./wp-store-context";

function useConnectionHost() {
  const { connections, selectedId, setSelectedId } = useWpStore();
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
  const [notice, setNotice] = useState("");

  const call = useCallback(
    async <T extends Record<string, unknown>>(path: string, method = "POST", body?: unknown): Promise<T | null> => {
      setBusy(true);
      setCallResult("");
      setNotice("");
      const res = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      setBusy(false);
      if (!res.ok) {
        setCallResult(errorMessageOrRaw(String(res.data?.error ?? "")) || "خطا در اجرای عملیات");
        return null;
      }
      // Every write on this panel is queued — the response's word for it is
      // `queued: true` in plugin mode, and the REST path drains the same
      // outbox — so one honest confirmation fits all of them.
      setNotice("درخواست در صف قرار گرفت و با اجرای بعدی به فروشگاه می‌رود.");
      return res.data;
    },
    [],
  );

  return { connections, busy, callResult, notice, selectedId, setSelectedId, call };
}

/**
 * No store yet. The old copy named «اتصال فروشگاه» — a section that no longer
 * exists in this app, since every technical connection moved to the
 * «اتصال‌های فنی» hub — so it told the owner to open something they could not
 * find. Name the real place, and link to it.
 */
function EmptyConnections({ children }: { children?: React.ReactNode }) {
  return (
    <div className={`${cardClass} flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-5`}>
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <PlugIcon aria-hidden="true" className="size-5" />
      </span>
      <p className="max-w-md text-sm leading-6 text-muted-foreground">
        {children ??
          "هنوز فروشگاه ووکامرسی متصل نیست. اتصال فروشگاه در «اتصال‌های فنی» انجام می‌شود؛ پس از اتصال و نخستین همگام‌سازی، دسته‌بندی‌ها و ویژگی‌ها اینجا دیده می‌شوند."}
      </p>
      <Button asChild size="sm" variant="outline">
        <Link href="/settings/connections?tab=woocommerce">اتصال فروشگاه ووکامرس</Link>
      </Button>
    </div>
  );
}

function HostFrame({
  connections,
  selectedId,
  setSelectedId,
  callResult,
  notice,
  children,
}: {
  connections: Connection[] | null;
  selectedId: string;
  setSelectedId: (id: string) => void;
  callResult: string;
  notice: string;
  children: React.ReactNode;
}) {
  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) return <EmptyConnections />;
  return (
    <div className="space-y-4">
      {/* One store needs no picker — a select with a single option is a
          control that cannot do anything. Name the store instead. */}
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        {connections.length > 1 ? (
          <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        ) : (
          <p className="min-w-0 text-sm text-muted-foreground">
            فروشگاه: <span className="font-medium text-foreground">{connections[0].name}</span>
          </p>
        )}
      </div>
      {selectedId ? (
        <>
          <PluginWaitNote connections={connections} selectedId={selectedId} />
          {children}
          {notice ? <p className="text-xs text-teal-700 dark:text-teal-300">{notice}</p> : null}
          <ErrorBox>{callResult}</ErrorBox>
        </>
      ) : null}
    </div>
  );
}

export function ProductsSectionHost() {
  const { connections, busy, callResult, notice, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <CatalogueSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function OrdersSectionHost() {
  const { connections, busy, callResult, notice, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <StoreOrdersSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function TaxonomiesSectionHost() {
  const { connections, callResult, notice, selectedId, setSelectedId } = useConnectionHost();
  return (
    <HostFrame
      connections={connections}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      callResult={callResult}
      notice={notice}
    >
      <TaxonomiesSection connectionId={selectedId} />
    </HostFrame>
  );
}
