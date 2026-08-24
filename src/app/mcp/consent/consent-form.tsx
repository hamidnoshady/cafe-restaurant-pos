"use client";

/**
 * The one screen in the OAuth flow where a human decides anything.
 *
 * Everything it shows is a decision the owner is making on behalf of a program
 * they cannot see: which of two grants it gets, and — if it gets the write
 * grant — whether its writes happen or wait. So the defaults matter more than
 * the layout. Read-only is preselected and approval-required is preselected,
 * because the safe answer must be the one you get by pressing the obvious
 * button, and «اجازه بده» must never quietly mean "and it can change my prices".
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox } from "@/app/dashboard/ui";
import {
  ALL_MCP_SCOPES,
  MCP_SCOPE_DESCRIPTIONS,
  MCP_SCOPE_LABELS,
  MCP_SCOPES,
  MCP_WRITE_MODE_LABELS,
  type McpScope,
  type McpWriteMode,
} from "@/lib/mcp/scopes";

interface ConsentInfo {
  client: { clientId: string; clientName: string };
  branch: { id: string; name: string } | null;
}

export function ConsentForm(props: {
  isOwner: boolean;
  featureEnabled: boolean;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  requestedScopes: string[];
}) {
  const [info, setInfo] = useState<ConsentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState<McpScope[]>([MCP_SCOPES.read]);
  const [writeMode, setWriteMode] = useState<McpWriteMode>("approve");
  const [name, setName] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ client_id: props.clientId });
    if (props.requestedScopes.length > 0) params.set("scope", props.requestedScopes.join(" "));
    const { ok, data } = await api<ConsentInfo & { error?: string }>(
      `/api/connections/mcp/consent?${params.toString()}`,
    );
    if (ok) {
      setInfo(data);
      setName(data.client.clientName);
    } else {
      setError(
        data.error === "invalid_client"
          ? "این درخواست معتبر نیست: برنامه‌ای با این شناسه نزد این کسب‌وکار ثبت نشده است."
          : "بارگذاری این درخواست ممکن نشد.",
      );
    }
    setLoading(false);
  }, [props.clientId, props.requestedScopes]);

  useEffect(() => {
    if (props.isOwner && props.featureEnabled && props.clientId) void load();
    else setLoading(false);
  }, [load, props.clientId, props.featureEnabled, props.isOwner]);

  function toggle(scope: McpScope) {
    setApproved((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function decide(allow: boolean) {
    if (!allow) {
      // A refusal is answered by the client's own redirect URI carrying
      // `access_denied`, which is what tells the connector to stop waiting.
      const url = new URL(props.redirectUri);
      url.searchParams.set("error", "access_denied");
      if (props.state !== null) url.searchParams.set("state", props.state);
      window.location.href = url.toString();
      return;
    }

    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ redirectTo?: string; error?: string }>(
      "/api/connections/mcp/consent",
      {
        method: "POST",
        body: JSON.stringify({
          clientId: props.clientId,
          redirectUri: props.redirectUri,
          codeChallenge: props.codeChallenge,
          state: props.state,
          requestedScopes: props.requestedScopes,
          approvedScopes: approved,
          writeMode,
          connectionName: name,
        }),
      },
    );
    setBusy(false);
    if (ok && data.redirectTo) {
      window.location.href = data.redirectTo;
      return;
    }
    const messages: Record<string, string> = {
      invalid_scopes: "حداقل یک دسترسی را انتخاب کنید.",
      invalid_client: "این درخواست معتبر نیست.",
      invalid_request: "این درخواست معتبر نیست.",
      no_location: "شعبه‌ای ثبت نشده است.",
      feature_disabled: "این امکان برای کسب‌وکار شما فعال نیست.",
    };
    setError(messages[data.error ?? ""] ?? "ثبت اجازه ممکن نشد.");
  }

  if (!props.isOwner) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>فقط مالک کسب‌وکار می‌تواند به یک برنامهٔ بیرونی اجازهٔ دسترسی بدهد. با حساب مالک وارد شوید و دوباره تلاش کنید.</ErrorBox>
      </ConsentShell>
    );
  }
  if (!props.featureEnabled) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>امکان «کلیدهای API و اتصال هوش مصنوعی» برای کسب‌وکار شما فعال نیست.</ErrorBox>
      </ConsentShell>
    );
  }
  if (loading) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      </ConsentShell>
    );
  }
  if (!info) {
    return (
      <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
        <ErrorBox>{error ?? "این درخواست معتبر نیست."}</ErrorBox>
      </ConsentShell>
    );
  }

  const canWrite = approved.includes(MCP_SCOPES.write);

  return (
    <ConsentShell title="اتصال برنامهٔ هوش مصنوعی">
      <p className="text-sm leading-6 text-muted-foreground">
        برنامهٔ <span className="font-semibold text-foreground">«{info.client.clientName}»</span> درخواست
        دسترسی به داده‌های این کسب‌وکار را دارد
        {info.branch ? <> (شعبهٔ «{info.branch.name}»)</> : null}. انتخاب کنید چه چیزی به آن بدهید.
      </p>

      <div className="mt-5 space-y-3">
        {ALL_MCP_SCOPES.map((scope) => (
          <label
            key={scope}
            className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200/80 p-3 hover:bg-stone-50"
          >
            <input
              type="checkbox"
              className="mt-1"
              checked={approved.includes(scope)}
              onChange={() => toggle(scope)}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{MCP_SCOPE_LABELS[scope]}</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                {MCP_SCOPE_DESCRIPTIONS[scope]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {canWrite ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
          <p className="mb-2 text-sm font-medium text-amber-950">تغییرها چطور اعمال شوند؟</p>
          <div className="space-y-2">
            {(["approve", "apply"] as McpWriteMode[]).map((mode) => (
              <label key={mode} className="flex cursor-pointer items-start gap-3">
                <input
                  type="radio"
                  name="writeMode"
                  className="mt-1"
                  checked={writeMode === mode}
                  onChange={() => setWriteMode(mode)}
                />
                <span className="min-w-0">
                  <span className="block text-sm">{MCP_WRITE_MODE_LABELS[mode]}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-amber-900/80">
                    {mode === "approve"
                      ? "هر تغییری در فهرست انتظار می‌ماند تا شما در «اتصال‌ها» تأییدش کنید. تا آن لحظه هیچ چیزی عوض نمی‌شود."
                      : "تغییرها بلافاصله ثبت می‌شوند. همهٔ آن‌ها در «گزارش عملیات دستیار» ثبت و قابل بازبینی‌اند."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : (
        <InfoBox>این اتصال فقط می‌تواند بخواند و هیچ تغییری در داده‌های شما نمی‌دهد.</InfoBox>
      )}

      <div className="mt-4">
        <label htmlFor="connection-name" className="mb-1 block text-sm text-muted-foreground">
          نام این اتصال (برای شناختنش در فهرست اتصال‌ها)
        </label>
        <input
          id="connection-name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-input px-3 py-2 text-start focus:border-primary focus:outline-none"
        />
      </div>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="mt-6 flex gap-3">
        <Button onClick={() => decide(true)} disabled={busy || approved.length === 0}>
          {busy ? "در حال ثبت…" : "اجازه بده"}
        </Button>
        <Button variant="outline" onClick={() => decide(false)} disabled={busy}>
          انصراف
        </Button>
      </div>
    </ConsentShell>
  );
}

function ConsentShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="mb-1 text-lg font-bold">{title}</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}
