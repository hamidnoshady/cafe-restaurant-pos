"use client";

/**
 * «چاپ و فاکتور» — the whole printing section, in four tabs.
 *
 *   قالب‌ها   — the five ready templates and the shop's own, as real previews.
 *   طراحی قالب — the block designer (opens from a card, not from the tab bar).
 *   چاپگرها   — pairing hardware, with discovery instead of typed IPs.
 *   لوگو      — the logo every template prints.
 *
 * The section also states, at the top and always, whether the local print
 * agent is running — because that single fact decides whether hardware
 * printing is possible at all, and the alternative (a failed print at the
 * counter with a customer waiting) is the worst place to learn it. When the
 * agent is down the section stays fully usable: designing, previewing and
 * printing through the browser's own dialog need nothing installed.
 */
import { useCallback, useMemo, useState } from "react";
import { FileTextIcon, ImageIcon, PrinterIcon, WifiOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { printDocument, printViaBrowser } from "@/lib/print-agent-client";
import {
  PAPERS,
  builtInTemplate,
  renderPrintTemplate,
  starterTemplate,
  type PrintTemplate,
} from "@/lib/print-template";
import { samplePrintDocument } from "@/lib/print-sample";
import { resolvedTransport } from "@/lib/printer-connection";
import { LoadingSkeleton, SectionCard, TabBar, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import { LogoPanel } from "./logo-panel";
import { PrinterHardware } from "./printer-hardware";
import { TemplateDesigner } from "./template-designer";
import { TemplateGallery } from "./template-gallery";
import {
  useAgentStatus,
  usePrintIdentity,
  usePrinterList,
  useSavedTemplates,
  type SavedTemplateRow,
} from "./use-printing";

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

  const printers = usePrinterList();
  const saved = useSavedTemplates();
  const identity = usePrintIdentity();
  const agent = useAgentStatus();

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
      // The printer whose paper matches, else the default for the kind, else
      // the browser — a preview print should never need a decision first.
      const kind = template.docType === "kitchen" ? "kitchen" : "receipt";
      const match =
        printers.printers.find((p) => p.is_active && p.connection?.paper === template.paper) ??
        printers.printers.find((p) => p.is_active && p.kind === kind && p.connection?.isDefault) ??
        printers.printers.find((p) => p.is_active && p.kind === kind);

      const canUseAgent = agent.online && match && resolvedTransport(match.connection) !== "browser";
      const result = canUseAgent
        ? await printDocument(match!.connection, html, template.paper)
        : await printViaBrowser(html);

      if (!result.ok) {
        setError(
          result.unreachable
            ? "هیچ مسیر چاپ سخت‌افزاری پاسخ نداد (نه عامل چاپ محلی و نه سرور برنامه)."
            : "چاپ نمونه انجام نشد.",
        );
        return;
      }
      setNotice(
        canUseAgent
          ? `نمونه روی «${match!.name}» فرستاده شد.`
          : `سند روی ${paper.label} در پنجرهٔ چاپ مرورگر باز شد.`,
      );
    },
    [agent.online, printers.printers, sample],
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

      <AgentBanner online={agent.online} via={agent.via} checking={agent.checking} onRecheck={() => void agent.recheck()} />

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

      {tab === "printers" ? (
        <PrinterHardware
          printers={printers.printers}
          loading={printers.loading}
          templates={saved.templates}
          agentOnline={agent.online}
          onChanged={printers.reload}
        />
      ) : null}

      {tab === "logo" ? <LogoPanel logo={identity.logo} onChanged={identity.reload} /> : null}
    </div>
  );
}

/**
 * The agent's state, said once and plainly. Not an error: printing through the
 * browser is a supported way to run this section, and a shop with a laser
 * printer and a tablet may never install the agent at all.
 */
function AgentBanner({
  online,
  via,
  checking,
  onRecheck,
}: {
  online: boolean;
  via: "agent" | "server" | null;
  checking: boolean;
  onRecheck: () => void;
}) {
  if (checking) return <LoadingSkeleton rows={1} label="در حال بررسی عامل چاپ" />;

  return (
    <SectionCard>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {online ? (
            <PrinterIcon className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
          ) : (
            <WifiOffIcon className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className="font-semibold text-foreground">
              {online
                ? via === "server"
                  ? "چاپ سخت‌افزاری از طریق سرور برنامه فعال است"
                  : "عامل چاپ محلی فعال است"
                : "چاپ سخت‌افزاری در دسترس نیست"}
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {online
                ? via === "server"
                  ? "عامل چاپ محلی اجرا نیست، اما سرور برنامه روی همین شبکه است و چاپگرهای نصب‌شدهٔ آن دستگاه، چاپگرهای حرارتی و کشوی پول از طریق آن در دسترس‌اند."
                  : "چاپگرهای حرارتی، کشوی پول و چاپگرهای نصب‌شدهٔ ویندوز در دسترس‌اند."
                : "بدون آن هم می‌توانید قالب طراحی کنید و با پنجرهٔ چاپ مرورگر روی هر چاپگری چاپ بگیرید؛ برای چاپگر حرارتی و کشوی پول، عامل چاپ را روی دستگاه صندوق اجرا کنید."}
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onRecheck}>
          بررسی دوباره
        </Button>
      </div>
    </SectionCard>
  );
}

/** Icons the settings nav uses for this section's tabs. Exported for the nav. */
export const PRINTING_TAB_ICONS = { templates: FileTextIcon, printers: PrinterIcon, logo: ImageIcon };
