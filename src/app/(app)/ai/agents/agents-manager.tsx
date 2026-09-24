"use client";

/**
 * «ایجنت‌ها» — a business's own custom AI agents (Phase I).
 *
 * The custom-agent engine shipped in Phase D: an agent is a named lens over the
 * dashboard assistant — its own instructions, a read-tool allowlist and an
 * action allowlist — and the chat route already runs a turn under one when
 * `agentId` is supplied. Its management UI was deferred to Phase I; this is it.
 *
 * Every write goes through `/api/ai/agents`, whose service validates each tool
 * and action against the live catalogue (an unknown one is rejected, never
 * silently dropped), so an agent built here can never allow a capability the
 * runtime does not actually offer. The tool/action checkboxes are rendered from
 * the `selectableTools`/`selectableActions` the GET returns, so the editor can
 * never drift from what the assistant can do.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import {
  MAX_AGENT_INSTRUCTIONS,
  MAX_AGENT_NAME,
  agentToolLabel,
  customAgentErrorMessage,
} from "@/lib/ai-custom-agents";
import { actionLabel } from "@/lib/ai";
import { api } from "@/app/dashboard/ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, inputClass } from "@/app/dashboard/ui";

interface AgentView {
  id: string;
  name: string;
  instructions: string;
  toolAllowlist: string[];
  actionAllowlist: string[];
  enabled: boolean;
}

interface Catalogue {
  selectableTools: string[];
  selectableActions: string[];
}

export function AgentsManager() {
  const locked = useFeatureLocked();
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AgentView | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ agents: AgentView[] } & Catalogue>("/api/ai/agents");
    if (ok) {
      setAgents(data.agents ?? []);
      setCatalogue({
        selectableTools: data.selectableTools ?? [],
        selectableActions: data.selectableActions ?? [],
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(a: AgentView) {
    setBusyId(a.id);
    const { ok, data } = await api<{ error?: string }>(`/api/ai/agents/${a.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...a, enabled: !a.enabled }),
    });
    setBusyId(null);
    if (!ok) {
      toast.error(customAgentErrorMessage(data.error ?? ""));
      return;
    }
    toast.success(a.enabled ? "غیرفعال شد" : "فعال شد");
    void load();
  }

  async function remove(a: AgentView) {
    if (!window.confirm(`«${a.name}» حذف شود؟`)) return;
    setBusyId(a.id);
    const { ok } = await api(`/api/ai/agents/${a.id}`, { method: "DELETE" });
    setBusyId(null);
    if (!ok) {
      toast.error("حذف نشد");
      return;
    }
    toast.success("حذف شد");
    void load();
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {agents.length > 0
            ? `${agents.length.toLocaleString("fa-IR")} ایجنت`
            : "هنوز ایجنتی نساخته‌اید."}
        </p>
        <Button
          type="button"
          onClick={() => setEditing((v) => (v === "new" ? null : "new"))}
          disabled={locked}
          className="gap-2"
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          {editing === "new" ? "بستن" : "ایجنت جدید"}
        </Button>
      </div>

      {editing !== null && catalogue ? (
        <AgentForm
          agent={editing === "new" ? null : editing}
          catalogue={catalogue}
          onDone={() => {
            setEditing(null);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {agents.length === 0 ? (
        <EmptyState>
          یک ایجنت بسازید تا دستیار با نقش و اجازه‌های مشخصی کار کند — مثلاً «تحلیلگر فروش» که فقط گزارش‌ها را
          می‌خواند، یا «مسئول انبار» که می‌تواند تعدیل موجودی پیشنهاد دهد.
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {agents.map((a) => (
            <SectionCard key={a.id} title={a.name}>
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone={a.enabled ? "positive" : "neutral"}>
                    {a.enabled ? "فعال" : "غیرفعال"}
                  </StatusBadge>
                  <StatusBadge tone="neutral">
                    {`${a.toolAllowlist.length.toLocaleString("fa-IR")} ابزار`}
                  </StatusBadge>
                  <StatusBadge tone={a.actionAllowlist.length > 0 ? "active" : "neutral"}>
                    {a.actionAllowlist.length > 0
                      ? `${a.actionAllowlist.length.toLocaleString("fa-IR")} عملیات`
                      : "فقط خواندنی"}
                  </StatusBadge>
                </div>
                {a.instructions ? (
                  <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {a.instructions}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === a.id}
                    onClick={() => setEditing(a)}
                  >
                    ویرایش
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === a.id}
                    onClick={() => toggle(a)}
                  >
                    {a.enabled ? "غیرفعال کن" : "فعال کن"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    disabled={busyId === a.id}
                    onClick={() => remove(a)}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    حذف
                  </Button>
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentForm({
  agent,
  catalogue,
  onDone,
  onCancel,
}: {
  agent: AgentView | null;
  catalogue: Catalogue;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [tools, setTools] = useState<Set<string>>(new Set(agent?.toolAllowlist ?? []));
  const [actions, setActions] = useState<Set<string>>(new Set(agent?.actionAllowlist ?? []));
  const [saving, setSaving] = useState(false);

  function toggleIn(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  async function submit() {
    if (!name.trim()) {
      toast.error("نام ایجنت را وارد کنید.");
      return;
    }
    setSaving(true);
    const payload = {
      name: name.trim(),
      instructions: instructions.trim(),
      toolAllowlist: [...tools],
      actionAllowlist: [...actions],
      enabled: agent?.enabled ?? true,
    };
    const { ok, data } = await api<{ error?: string; messages?: string[] }>(
      agent ? `/api/ai/agents/${agent.id}` : "/api/ai/agents",
      { method: agent ? "PUT" : "POST", body: JSON.stringify(payload) },
    );
    setSaving(false);
    if (!ok) {
      toast.error(data.messages?.[0] ?? customAgentErrorMessage(data.error ?? ""));
      return;
    }
    toast.success(agent ? "ایجنت به‌روزرسانی شد" : "ایجنت ساخته شد");
    onDone();
  }

  return (
    <SectionCard title={agent ? `ویرایش «${agent.name}»` : "ایجنت جدید"}>
      <div className="space-y-1">
        <Field label="نام ایجنت">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً: تحلیلگر فروش"
            maxLength={MAX_AGENT_NAME}
          />
        </Field>

        <Field label="دستورالعمل (نقش و لحن)" hint={`حداکثر ${MAX_AGENT_INSTRUCTIONS.toLocaleString("fa-IR")} نویسه`}>
          <textarea
            className={`${inputClass} h-28 py-2`}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="مثلاً: تو یک تحلیلگر فروش هستی. فقط بر پایهٔ گزارش‌ها پاسخ بده و همیشه پیشنهاد عملی بده."
            maxLength={MAX_AGENT_INSTRUCTIONS}
          />
        </Field>

        <Field label="ابزارهای خواندنی مجاز" as="div" hint="ایجنت فقط به این ابزارهای خواندن دسترسی دارد.">
          <div className="grid gap-2 sm:grid-cols-2">
            {catalogue.selectableTools.map((tool) => (
              <label
                key={tool}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-border/80 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={tools.has(tool)}
                  onChange={() => setTools((s) => toggleIn(s, tool))}
                />
                {agentToolLabel(tool)}
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="عملیات مجاز برای پیشنهاد"
          as="div"
          hint="ایجنت فقط این نوع عملیات را می‌تواند پیشنهاد دهد؛ خالی یعنی فقط خواندنی."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {catalogue.selectableActions.map((action) => (
              <label
                key={action}
                className="flex min-h-11 items-center gap-2 rounded-lg border border-border/80 px-3 py-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={actions.has(action)}
                  onChange={() => setActions((s) => toggleIn(s, action))}
                />
                {actionLabel(action)}
              </label>
            ))}
          </div>
        </Field>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button type="button" onClick={submit} disabled={saving} size="lg" className="font-semibold">
            {saving ? "در حال ذخیره…" : agent ? "ذخیرهٔ تغییرات" : "ساخت ایجنت"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving} size="lg">
            انصراف
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}
