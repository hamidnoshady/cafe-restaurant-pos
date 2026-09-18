"use client";

/**
 * Host for the existing WooCommerce store sections
 * (CatalogueSection / StoreOrdersSection / TaxonomiesSection) inside the WP
 * Manager app: pick a connection, then render the section against it. Those
 * components accept a `connectionId` prop so every WP Manager surface can use
 * the same selected store; the connection is chosen once here.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PlugIcon } from "lucide-react";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { CatalogueSection, StoreOrdersSection } from "./woo-store-sections";
import { TaxonomiesSection } from "./taxonomies-section";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";

type Connection = ConnectionLite;

function useConnectionHost() {
  const locked = useFeatureLocked();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    // Inside a locked preview the API answers `feature_disabled`, so the
    // request only exists to paint the preview with an error. Skip it and
    // show the same "no store" state the preview is meant to demonstrate.
    if (locked) {
      setConnections([]);
      return;
    }
    let alive = true;
    api<{ connections: Connection[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      // Without this, navigating away mid-flight set state on an unmounted
      // host and, worse, re-selected the first store after the member had
      // already picked another one on the screen they moved to.
      if (!alive) return;
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else {
        setConnections([]);
      }
    });
    return () => {
      alive = false;
    };
  }, [locked]);

  const call = useCallback(
    async <T extends Record<string, unknown>>(path: string, method = "POST", body?: unknown): Promise<T | null> => {
      setBusy(true);
      setCallResult("");
      const res = await api<T>(path, { method, body: body ? JSON.stringify(body) : undefined });
      setBusy(false);
      if (!res.ok) {
        setCallResult(String(res.data?.error ?? "خطا در اجرای عملیات"));
        return null;
      }
      return res.data;
    },
    [],
  );

  return { connections, busy, callResult, selectedId, setSelectedId, call };
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
  children,
}: {
  connections: Connection[] | null;
  selectedId: string;
  setSelectedId: (id: string) => void;
  callResult: string;
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
          <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId} />
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
          {callResult ? (
            <p
              role="alert"
              className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
            >
              {callResult}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ProductsSectionHost() {
  const { connections, busy, callResult, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame connections={connections} selectedId={selectedId} setSelectedId={setSelectedId} callResult={callResult}>
      <CatalogueSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function OrdersSectionHost() {
  const { connections, busy, callResult, selectedId, setSelectedId, call } = useConnectionHost();
  return (
    <HostFrame connections={connections} selectedId={selectedId} setSelectedId={setSelectedId} callResult={callResult}>
      <StoreOrdersSection connectionId={selectedId} busy={busy} call={call} />
    </HostFrame>
  );
}

export function TaxonomiesSectionHost() {
  const { connections, callResult, selectedId, setSelectedId } = useConnectionHost();
  return (
    <HostFrame connections={connections} selectedId={selectedId} setSelectedId={setSelectedId} callResult={callResult}>
      <TaxonomiesSection connectionId={selectedId} />
    </HostFrame>
  );
}
