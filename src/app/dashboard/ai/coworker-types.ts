/**
 * Phase 32 — the shapes `/api/ai/coworker/*` returns, shared by the three
 * panels that render them. Kept next to the panels rather than in `src/lib`
 * because they describe this screen's own wire format, not domain logic.
 */
import type {
  CoworkerApprovalMode,
  CoworkerEventKind,
  CoworkerRunStatus,
  CoworkerTriggerKind,
} from "@/lib/ai-coworker";
import type { CoworkerTemplate, CoworkerTemplateKey } from "@/lib/ai-coworker-templates";
import type { AccountingFinding } from "@/lib/accounting-review";

export interface CoworkerJobView {
  id: string;
  locationId: string | null;
  templateKey: CoworkerTemplateKey;
  title: string;
  triggerKind: CoworkerTriggerKind;
  eventKind: CoworkerEventKind | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  params: Record<string, unknown>;
  approvalMode: CoworkerApprovalMode;
  enabled: boolean;
  lastRunAt: string | null;
}

export interface CoworkerRunActionView {
  id: string;
  seq: number;
  actionType: string;
  title: string;
  summary: string;
  status: "pending" | "applied" | "failed" | "rejected" | "skipped";
  heldReason: string | null;
  error: string | null;
}

export interface CoworkerRunView {
  id: string;
  jobId: string;
  jobTitle: string;
  templateKey: CoworkerTemplateKey;
  triggerSource: string;
  status: CoworkerRunStatus;
  summary: string;
  facts: { findings?: AccountingFinding[] };
  createdAt: string;
  decidedBy: string | null;
  actions: CoworkerRunActionView[];
}

export interface CoworkerOptions {
  activeLocationId: string | null;
  inventoryItems: { id: string; name: string; unit: string; quantity: string }[];
  formulas: { id: string; name: string; outputName: string }[];
  branches: { id: string; name: string }[];
  messageTemplates: { id: string; name: string; channel: "sms" | "email" }[];
  projects: { id: string; name: string }[];
}

export interface CoworkerCatalogue {
  templates: CoworkerTemplate[];
  options: CoworkerOptions;
  labels: {
    triggers: Record<string, string>;
    events: Record<string, string>;
    approval: Record<string, string>;
    wasteReasons: readonly { value: string; label: string }[];
  };
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
