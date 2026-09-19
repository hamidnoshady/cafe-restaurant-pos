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
import { Button } from "@/components/ui/button";
import { api, ErrorBox, errorMessageOrRaw } from "@/app/dashboard/ui";
import { EmptyState, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { CatalogueSection, StoreOrdersSection, TaxonomiesSection } from "./woo-store-sections";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";

type Connection = ConnectionLite;

function useConnectionHost() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    api<{ connections: Connection[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else {
        setConnections([]);
      }
    });
  }, []);

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

function EmptyConnections({ children }: { children?: React.ReactNode }) {
  return (
    <EmptyState>
      {children ?? (
        <span className="flex flex-col items-center gap-3 py-6 text-center">
          <span>فروشگاهی متصل نیست. ابتدا از «اتصال‌های فنی» یک فروشگاه ووکامرس متصل کنید.</span>
          <Link href="/settings/connections?tab=woocommerce">
            <Button size="sm">اتصال فروشگاه</Button>
          </Link>
        </span>
      )}
    </EmptyState>
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
      <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId} />
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
