"use client";

/**
 * Host for the existing WooCommerce store sections
 * (CatalogueSection / StoreOrdersSection / TaxonomiesSection) inside the WP
 * Manager app: pick a connection, then render the section against it. Those
 * components accept a `connectionId` prop so every WP Manager surface can use
 * the same selected store; the connection is chosen once here.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "../ui";
import { cardClass, EmptyState, SectionCardSkeleton } from "../page-chrome";
import { CatalogueSection, StoreOrdersSection, TaxonomiesSection } from "./woo-store-sections";
import { PluginWaitNote } from "./plugin-wait-note";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";

type Connection = ConnectionLite;

function useConnectionHost() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [callResult, setCallResult] = useState("");
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

function EmptyConnections({ children }: { children?: React.ReactNode }) {
  return <EmptyState>{children ?? "فروشگاهی متصل نیست. ابتدا از بخش «اتصال فروشگاه» یک فروشگاه ووکامرس متصل کنید."}</EmptyState>;
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
      <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId} />
      {selectedId ? (
        <>
          <PluginWaitNote connections={connections} selectedId={selectedId} />
          {children}
          {callResult ? <p className="text-xs text-red-600 dark:text-red-400">{callResult}</p> : null}
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
