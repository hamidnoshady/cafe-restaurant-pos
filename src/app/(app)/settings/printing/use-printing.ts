"use client";

/**
 * Everything the printing section reads: the branch's printers, its saved
 * templates, the business header/logo a preview needs, and the local print
 * agent's status. One hook per concern, all of them refetchable, because the
 * section's four tabs edit each other's data — pairing a printer changes what
 * the template gallery can print to, uploading a logo changes every preview.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/app/dashboard/ui";
import { checkAgent, type AgentHealth } from "@/lib/print-agent-client";
import type { PrinterConnection } from "@/lib/printer-connection";
import type { PrintBusinessInfo, PrintTemplate } from "@/lib/print-template";

export interface PrinterRow {
  id: string;
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  is_active: boolean;
}

export interface SavedTemplateRow extends PrintTemplate {
  id: string;
  isDefault: boolean;
  updatedAt: string;
}

export function usePrinterList() {
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const { ok, data } = await api<{ printers: PrinterRow[]; error?: string }>("/api/settings/printers");
    if (ok) {
      setPrinters(data.printers ?? []);
      setError("");
    } else {
      setError(data.error ?? "unknown");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { printers, loading, error, reload };
}

export function useSavedTemplates() {
  const [templates, setTemplates] = useState<SavedTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const { ok, data } = await api<{ templates: SavedTemplateRow[] }>("/api/settings/print-templates");
    if (ok) setTemplates(data.templates ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { templates, loading, reload };
}

interface BusinessResponse {
  business: { name: string } | null;
  location: { name: string; address: string | null; phone: string | null } | null;
  profile: { legalName?: string; taxId?: string; email?: string; website?: string; receiptFooter?: string } | null;
}

export interface LogoRecord {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  updatedAt: string;
}

/** The header a preview prints: business identity plus the uploaded logo. */
export function usePrintIdentity() {
  const [business, setBusiness] = useState<PrintBusinessInfo>({ name: "" });
  const [logo, setLogo] = useState<LogoRecord | null>(null);
  const [footer, setFooter] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const [profile, logoRes] = await Promise.all([
      api<BusinessResponse>("/api/settings/business"),
      api<{ logo: LogoRecord | null }>("/api/settings/business/logo"),
    ]);
    if (profile.ok) {
      setBusiness({
        name: profile.data.business?.name ?? "",
        legalName: profile.data.profile?.legalName ?? null,
        address: profile.data.location?.address ?? null,
        phone: profile.data.location?.phone ?? null,
        taxId: profile.data.profile?.taxId ?? null,
        email: profile.data.profile?.email ?? null,
        website: profile.data.profile?.website ?? null,
      });
      setFooter(profile.data.profile?.receiptFooter ?? "");
    }
    if (logoRes.ok) setLogo(logoRes.data.logo ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    business: { ...business, logoDataUrl: logo?.dataUrl ?? null } as PrintBusinessInfo,
    logo,
    footer,
    loading,
    reload,
  };
}

/**
 * Is hardware printing available? Polled once on mount and on demand — the
 * answer decides whether the section offers hardware printing or only the
 * browser dialog, and saying so plainly is better than a failed print later.
 * Two backends can say yes: the loopback print agent on this device, or the
 * app server's own /api/print routes (`via: "server"`) — the client tries
 * the agent first and falls back to the server (print-agent-client.ts).
 */
export function useAgentStatus() {
  const [health, setHealth] = useState<AgentHealth | null>(null);
  const [via, setVia] = useState<"agent" | "server" | null>(null);
  const [checking, setChecking] = useState(true);

  const recheck = useCallback(async () => {
    setChecking(true);
    const result = await checkAgent();
    setHealth(result.ok ? (result.data ?? { ok: true }) : null);
    setVia(result.ok ? (result.via ?? "agent") : null);
    setChecking(false);
  }, []);

  useEffect(() => {
    void recheck();
  }, [recheck]);

  return { health, online: health?.ok === true, via, checking, recheck };
}
