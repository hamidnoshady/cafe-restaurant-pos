"use client";

/**
 * Desktop pairing codes for one business.
 *
 * The plaintext code exists only in the response to the issue request — this
 * component holds it in state so the operator can copy it, and it is gone on
 * the next render pass. Re-issuing revokes whatever was live, so the list
 * never shows two usable codes.
 */
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, Button, Card, ErrorBox, InfoBox, useCan } from "../../ui";
import { useBusiness } from "./context";

interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: "valid" | "code_expired" | "code_already_redeemed" | "code_revoked";
}

const STATE_LABELS: Record<PairingCodeSummary["state"], { label: string; cls: string }> = {
  valid: { label: "فعال", cls: "text-emerald-300" },
  code_expired: { label: "منقضی", cls: "text-white/40" },
  code_already_redeemed: { label: "استفاده‌شده", cls: "text-sky-300" },
  code_revoked: { label: "لغوشده", cls: "text-white/40" },
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

export function PairingPanel() {
  const { id, version } = useBusiness();
  const can = useCan();
  const allowed = can("business.provision");

  const [codes, setCodes] = useState<PairingCodeSummary[]>([]);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!allowed) return;
    const { ok, data } = await api<{ codes?: PairingCodeSummary[]; error?: string }>(
      `/api/platform/pairing?businessId=${encodeURIComponent(id)}`,
    );
    if (ok) setCodes(data.codes ?? []);
    else setError(errorMessage(data.error));
  }, [id, allowed, version]);

  useEffect(() => {
    void load();
  }, [load]);

  async function issue() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ code?: string; error?: string }>("/api/platform/pairing", {
      method: "POST",
      body: JSON.stringify({ businessId: id }),
    });
    setBusy(false);
    if (ok && data.code) {
      setIssuedCode(data.code);
      setNotice("کد ساخته شد. همین حالا آن را کپی کنید — دیگر نمایش داده نمی‌شود.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function revoke(codeId: string) {
    if (!confirm("این کد اتصال لغو شود؟")) return;
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/pairing", {
      method: "DELETE",
      body: JSON.stringify({ businessId: id, codeId }),
    });
    if (ok) {
      setIssuedCode(null);
      setNotice("کد لغو شد.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (!allowed) return null;

  return (
    <Card title="کد اتصال نصب دسکتاپ">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      <p className="mb-4 text-sm text-white/60">
        یک کد یک‌بارمصرف بسازید و آن را به مالک بدهید تا نصب دسکتاپ، تنظیمات این کسب‌وکار را
        دریافت کند. ساختن کد جدید، کد فعال قبلی را لغو می‌کند.
      </p>

      {issuedCode ? (
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="mb-2 text-xs text-emerald-200/70">این کد فقط همین یک بار نمایش داده می‌شود:</p>
          <div className="flex flex-wrap items-center gap-3">
            <code className="select-all font-mono text-xl tracking-widest text-emerald-100" dir="ltr">
              {issuedCode}
            </code>
            <Button
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(issuedCode);
                setNotice("کد کپی شد.");
              }}
            >
              کپی
            </Button>
          </div>
        </div>
      ) : null}

      <Button onClick={issue} disabled={busy}>
        {busy ? "در حال ساخت…" : "ساخت کد اتصال"}
      </Button>

      {codes.length === 0 ? (
        <p className="mt-4 text-sm text-white/40">هنوز کدی صادر نشده است.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {codes.map((code) => {
            const state = STATE_LABELS[code.state];
            return (
              <div
                key={code.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/2 p-3 text-sm"
              >
                <div>
                  <span className={`font-medium ${state.cls}`}>{state.label}</span>
                  <p className="mt-0.5 text-xs text-white/30">
                    صدور {fmtDate(code.createdAt)} ← انقضا {fmtDate(code.expiresAt)}
                  </p>
                  {code.redeemedAt ? (
                    <p className="mt-0.5 text-xs text-white/30">
                      استفاده در {fmtDate(code.redeemedAt)}
                    </p>
                  ) : null}
                </div>
                {code.state === "valid" ? (
                  <button
                    type="button"
                    onClick={() => revoke(code.id)}
                    className="rounded-md border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10"
                  >
                    لغو
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
