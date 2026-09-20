"use client";

/**
 * «چاپ و فاکتور» — the whole printing section, in three tabs with cleanly
 * separated concerns:
 *
 *   چاپگرها    — hardware connection (the printers panel; connection
 *                mechanics live in its add/edit dialog).
 *   قالب‌ها     — template design (opens the designer from a card).
 *   لوگو       — the logo every template prints.
 *
 * Template design never mixes with hardware connection: a user adding a
 * printer never sees template-management complexity unless they deliberately
 * open Advanced settings inside the add-printer dialog.
 */
import { useCallback, useMemo, useState } from "react";
import { FileTextIcon, ImageIcon, PrinterIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { printDocument, printViaBrowser } from "@/lib/printing/client";
import {
  PAPERS,
  builtInTemplate,
  renderPrintTemplate,
  starterTemplate,
  type PrintTemplate,
} from "@/lib/print-template";
import { samplePrintDocument } from "@/lib/print-sample";
import { LoadingSkeleton, TabBar, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import { LogoPanel } from "./logo-panel";
import { PrintersPanel } from "./printers-panel";
import { TemplateDesigner } from "./template-designer";
import { TemplateGallery } from "./template-gallery";
import { usePrintIdentity, useSavedTemplates, type SavedTemplateRow } from "./use-printing";

type Tab = "templates" | "printers" | "logo";

const TABS = [
  { key: "templates" as const, label: "قالب‌ها" },
  { key: "printers" as const, label: "چاپگرها" },
  { key: "logo" as const, label: "لوگو" },
];

interface Editing {
  template: PrintTemplate;
  /** The row being edited; absent for a brand-new or duplicated template. */
  id?: string;
}

export function PrintingManager() {
  const [tab, setTab] = useState<Tab>("templates");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const saved = useSavedTemplates();
  const identity = usePrintIdentity();

  // The preview document: the sample sale, wearing this business's identity
  // and logo, so what the gallery shows is what this shop will print.
  const sample = useMemo(
    () => samplePrintDocument(identity.business, { footer: identity.footer || "با تشکر از خرید شما" }),
    [identity.business, identity.footer],
  );

  const printSample = useCallback(
    async (template: PrintTemplate) => {
      setError("");
      setNotice("");
      const html = renderPrintTemplate(template, sample);
      const paper = PAPERS[template.paper];
      // Sheets (A4/A5 invoices) are a browser-dialog job by design — they
      // never ride the thermal connector. Thermal papers print through the
      // branch's default printer for the document's kind; with no printer
      // paired, the browser dialog is the no-hardware path.
      if (paper.kind === "sheet") {
        const result = await printViaBrowser(html);
        if (!result.ok) setError("باز کردن پنجرهٔ چاپ ممکن نشد.");
        else setNotice(`سند روی ${paper.label} در پنجرهٔ چاپ مرورگر باز شد.`);
        return;
      }
      const kind = template.docType === "kitchen" ? "kitchen" : "receipt";
      const { ok, data } = await api<{ printers?: { id: string; name: string; kind: string; isDefault: boolean; needsReconnect: boolean }[] }>("/api/printers");
      const printers = data.printers ?? [];
      const match =
        printers.find((p) => p.kind === kind && p.isDefault && !p.needsReconnect) ??
        printers.find((p) => p.kind === kind && !p.needsReconnect);
      if (!ok || !match) {
        const result = await printViaBrowser(html);
        if (!result.ok) setError("باز کردن پنجرهٔ چاپ ممکن نشد.");
        else setNotice(`سند روی ${paper.label} در پنجرهٔ چاپ مرورگر باز شد.`);
        return;
      }
      const result = await printDocument(match.id, html, template.paper);
      if (!result.ok) {
        setError(
          result.error === "connector_not_installed" || result.error === "connector_outdated"
            ? "چاپ سخت‌افزاری نیاز به رابط چاپ دارد؛ از تب «چاپگرها» آن را نصب کنید."
            : "چاپ نمونه انجام نشد.",
        );
        return;
      }
      setNotice(`نمونه روی «${match.name ?? "چاپگر"}» فرستاده شد.`);
    },
    [sample],
  );

  async function saveTemplate(isDefault: boolean) {
    if (!editing) return;
    setSaving(true);
    setError("");
    const body = JSON.stringify({ template: editing.template, isDefault });
    const { ok, data } = editing.id
      ? await api<{ error?: string }>(`/api/settings/print-templates/${editing.id}`, { method: "PUT", body })
      : await api<{ error?: string }>("/api/settings/print-templates", { method: "POST", body });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setEditing(null);
    setNotice("قالب ذخیره شد.");
    await saved.reload();
  }

  async function deleteTemplate(template: SavedTemplateRow) {
    if (!window.confirm(`قالب «${template.name}» حذف شود؟`)) return;
    const { ok, data } = await api<{ error?: string }>(`/api/settings/print-templates/${template.id}`, { method: "DELETE" });
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("قالب حذف شد.");
    await saved.reload();
  }

  if (identity.loading) return <LoadingSkeleton rows={5} />;

  if (editing) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">طراحی قالب</p>
            <h2 className="mt-0.5 truncate font-semibold text-foreground">{editing.template.name || "قالب بدون نام"}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void printSample(editing.template)}>
              <PrinterIcon aria-hidden="true" />
              چاپ نمونه
            </Button>
          </div>
        </div>
        <TemplateDesigner
          value={editing.template}
          onChange={(template) => setEditing({ ...editing, template })}
          data={sample}
          onSave={(isDefault) => void saveTemplate(isDefault)}
          onCancel={() => setEditing(null)}
          saving={saving}
          savedLabel={editing.id ? "ذخیرهٔ تغییرات" : "ساخت قالب"}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <TabBar idPrefix="printing" label="بخش‌های چاپ" tabs={TABS} active={tab} onChange={setTab} />

      {tab === "templates" ? (
        saved.loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <TemplateGallery
            saved={saved.templates}
            data={sample}
            busy={saving}
            onNew={() => setEditing({ template: starterTemplate("thermal80", "receipt") })}
            onDuplicate={(template) =>
              setEditing({
                template: {
                  ...template,
                  key: "",
                  name: `${template.name} — کپی`,
                  blocks: template.blocks.map((b) => ({ ...b })),
                  options: { ...template.options },
                },
              })
            }
            onEdit={(template) => setEditing({ id: template.id, template })}
            onDelete={(template) => void deleteTemplate(template)}
            onPrint={(template) => void printSample(template)}
          />
        )
      ) : null}

      {tab === "printers" ? <PrintersPanel templates={saved.templates} /> : null}

      {tab === "logo" ? <LogoPanel logo={identity.logo} onChanged={identity.reload} /> : null}
    </div>
  );
}

function TabBarMemo({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) {
  return <TabBar idPrefix="printing" label="بخش‌های چاپ" tabs={TABS} active={active} onChange={onChange} />;
}

/** Icons the settings nav uses for this section's tabs. Exported for the nav. */
export const PRINTING_TAB_ICONS = { templates: FileTextIcon, printers: PrinterIcon, logo: ImageIcon };
