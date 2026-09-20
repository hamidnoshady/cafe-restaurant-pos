"use client";

/**
 * Phase E — the structured input protocol's card. Renders a typed request the
 * assistant raised (a choice, a multi-choice, or a form) and collects a
 * validated answer, so the user picks or fills in exactly what the model asked
 * for instead of typing prose the model then has to parse.
 *
 * The answer shape mirrors `InputResponse` in ai-input-protocol.ts; the server
 * re-validates it against the stored spec on submit, so this component is a
 * convenience, never the source of truth for what is allowed.
 */
import { useState } from "react";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import type { InputRequestSpec, InputResponse } from "@/lib/ai-input-protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const OTHER_KEY = "__other__";

export function AiInputRequestCard({
  spec,
  answered,
  dismissed,
  busy,
  onSubmit,
  onDismiss,
}: {
  spec: InputRequestSpec;
  answered?: boolean;
  dismissed?: boolean;
  busy?: boolean;
  onSubmit: (response: InputResponse) => void;
  onDismiss: () => void;
}) {
  // choice: one selected option id (or OTHER_KEY). multi: a set. form: keyed.
  const [choice, setChoice] = useState<string | null>(null);
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [other, setOther] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>({});

  const locked = Boolean(answered || dismissed);

  function toggleMulti(id: string) {
    setMulti((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submit() {
    if (spec.kind === "choice") {
      if (choice === OTHER_KEY) onSubmit({ other: other.trim() });
      else if (choice) onSubmit({ choice });
      return;
    }
    if (spec.kind === "multi_choice") {
      const response: InputResponse = { choices: [...multi] };
      if (spec.allowOther && other.trim()) response.other = other.trim();
      onSubmit(response);
      return;
    }
    // form
    const out: Record<string, string | number | boolean> = {};
    for (const field of spec.fields ?? []) {
      const raw = values[field.key];
      if (raw === undefined || raw === "") continue;
      out[field.key] = field.type === "number" ? Number(raw) : raw;
    }
    onSubmit({ values: out });
  }

  const canSubmit = (() => {
    if (locked) return false;
    if (spec.kind === "choice") {
      return choice === OTHER_KEY ? other.trim().length > 0 : Boolean(choice);
    }
    if (spec.kind === "multi_choice") {
      return multi.size > 0 || (spec.allowOther ? other.trim().length > 0 : false);
    }
    // form — every required field must have a value.
    return (spec.fields ?? []).every((field) => {
      if (!field.required) return true;
      const raw = values[field.key];
      if (field.type === "boolean") return raw !== undefined;
      return raw !== undefined && String(raw).trim() !== "";
    });
  })();

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-primary">
        <MessageSquareIcon className="size-4" />
        {spec.prompt}
      </div>

      {answered ? (
        <p className="flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-4" /> پاسخ ثبت شد
        </p>
      ) : dismissed ? (
        <p className="text-muted-foreground">این پرسش رد شد.</p>
      ) : (
        <>
          {(spec.kind === "choice" || spec.kind === "multi_choice") && (
            <div className="mb-2 flex flex-col gap-1.5">
              {(spec.options ?? []).map((option) => {
                const selected =
                  spec.kind === "choice" ? choice === option.id : multi.has(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      spec.kind === "choice" ? setChoice(option.id) : toggleMulti(option.id)
                    }
                    className={`rounded-lg border px-3 py-2 text-start transition ${
                      selected
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
              {spec.allowOther && (
                <div className="flex flex-col gap-1.5">
                  {spec.kind === "choice" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setChoice(OTHER_KEY)}
                      className={`rounded-lg border px-3 py-2 text-start transition ${
                        choice === OTHER_KEY
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "border-border hover:bg-muted"
                      }`}
                    >
                      سایر…
                    </button>
                  )}
                  {(spec.kind === "multi_choice" || choice === OTHER_KEY) && (
                    <Input
                      value={other}
                      disabled={busy}
                      onChange={(e) => setOther(e.target.value)}
                      placeholder="پاسخ دیگر…"
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {spec.kind === "form" && (
            <div className="mb-2 flex flex-col gap-2.5">
              {(spec.fields ?? []).map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <Label className="text-xs text-foreground/80">
                    {field.label}
                    {field.required ? <span className="text-destructive"> *</span> : null}
                  </Label>
                  {field.type === "boolean" ? (
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={values[field.key] === true}
                        onChange={(e) =>
                          setValues((v) => ({ ...v, [field.key]: e.target.checked }))
                        }
                      />
                      <span className="text-muted-foreground">{field.placeholder ?? "بله"}</span>
                    </label>
                  ) : field.type === "select" ? (
                    <select
                      disabled={busy}
                      value={(values[field.key] as string) ?? ""}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">—</option>
                      {(field.options ?? []).map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                      disabled={busy}
                      value={(values[field.key] as string) ?? ""}
                      placeholder={field.placeholder}
                      onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={submit} disabled={busy || !canSubmit}>
              <CheckIcon aria-hidden="true" />
              {busy ? "در حال ارسال…" : "ارسال پاسخ"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={busy}>
              رد
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
