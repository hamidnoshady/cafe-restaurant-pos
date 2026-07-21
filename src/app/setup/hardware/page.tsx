"use client";

import { useCallback, useEffect, useState } from "react";
import { kickDrawer, testPrint } from "@/lib/print-agent-client";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";

interface Printer {
  id: string;
  name: string;
  kind: "receipt" | "kitchen";
  connection: { ip?: string | null; port?: number };
}

export default function HardwareStep() {
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"receipt" | "kitchen">("receipt");
  const [ip, setIp] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");

  const load = useCallback(() => {
    api<{ printers: Printer[] }>("/api/setup/hardware").then(({ data }) => {
      if (data.printers) setPrinters(data.printers);
    });
  }, []);
  useEffect(load, [load]);

  async function addPrinter(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/setup/hardware", {
      method: "POST",
      body: JSON.stringify({ addPrinter: { name, kind, ip } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));
    setName("");
    setIp("");
    load();
  }

  async function test(printer: Printer, target: "print" | "drawer") {
    setBusy(true);
    setError("");
    setPreview("");

    // Try the real local print agent first (src/lib/print-agent-client.ts);
    // it's a separate process on the till PC and may not be running,
    // especially during the wizard on a fresh setup — that's fine, the
    // stub call below still marks the wizard step done and shows a
    // simulated preview so the pairing flow works either way.
    const agentResult =
      target === "drawer" ? await kickDrawer(printer.connection) : await testPrint(printer.connection, printer.kind);

    const { ok, data } = await api<{ error?: string; preview?: string }>("/api/setup/hardware", {
      method: "POST",
      body: JSON.stringify({ test: { printerId: printer.id, target } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));

    setPreview(
      agentResult.ok
        ? target === "drawer"
          ? "کشوی پول با موفقیت باز شد."
          : "چاپ آزمایشی روی چاپگر واقعی ارسال شد."
        : `${data.preview ?? ""}\n\n(دستگاه چاپ محلی در دسترس نیست — این فقط یک پیش‌نمایش شبیه‌سازی‌شده است.)`,
    );
  }

  return (
    <StepShell
      step="hardware"
      description="چاپگر رسید و آشپزخانه را ثبت و آزمایش کنید. اتصال واقعی ESC/POS در فاز ۵ فعال می‌شود؛ این‌جا فقط جریان جفت‌سازی و چاپ آزمایشی است."
      showSkip
      showNext
    >
      <InfoBox>
        چاپ آزمایشی فعلاً «آزمایشی/شبیه‌سازی» است — چیزی واقعاً چاپ نمی‌شود، فقط پیش‌نمایش رسید را
        می‌بینید و رویداد ثبت می‌شود.
      </InfoBox>
      <ErrorBox>{error}</ErrorBox>

      <div className="grid gap-8 lg:grid-cols-2">
        <form onSubmit={addPrinter} className="rounded-xl border border-border p-4">
          <h2 className="mb-3 font-semibold">افزودن چاپگر</h2>
          <Field label="نام *">
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثلاً چاپگر صندوق"
              required
            />
          </Field>
          <Field label="نوع">
            <select
              className={inputClass}
              value={kind}
              onChange={(e) => setKind(e.target.value as "receipt" | "kitchen")}
            >
              <option value="receipt">رسید (صندوق)</option>
              <option value="kitchen">آشپزخانه</option>
            </select>
          </Field>
          <Field label="نشانی IP" hint="اختیاری — بعداً هم قابل تنظیم است (پورت پیش‌فرض ۹۱۰۰).">
            <input
              className={inputClass}
              dir="ltr"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.50"
            />
          </Field>
          <PrimaryButton disabled={busy}>ثبت چاپگر</PrimaryButton>
        </form>

        <div>
          <h2 className="mb-3 font-semibold">چاپگرهای ثبت‌شده</h2>
          {printers.length === 0 ? (
            <p className="text-sm text-muted-foreground">هنوز چاپگری ثبت نشده است.</p>
          ) : (
            <ul className="space-y-2">
              {printers.map((p) => (
                <li key={p.id} className="rounded-lg border border-border px-4 py-3">
                  <div className="mb-2 flex items-center justify-between text-sm">
                    <span className="font-medium">
                      {p.name}
                      <span className="ms-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {p.kind === "kitchen" ? "آشپزخانه" : "رسید"}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {p.connection?.ip ?? "—"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <SecondaryButton onClick={() => test(p, "print")} disabled={busy}>
                      چاپ آزمایشی
                    </SecondaryButton>
                    <SecondaryButton onClick={() => test(p, "drawer")} disabled={busy}>
                      آزمایش کشوی پول
                    </SecondaryButton>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {preview ? (
            <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-foreground p-4 font-sans text-sm leading-7 text-background">
              {preview}
            </pre>
          ) : null}
        </div>
      </div>
    </StepShell>
  );
}
