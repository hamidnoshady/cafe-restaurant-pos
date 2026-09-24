"use client";

/**
 * The permission editor — one component, used everywhere access is edited.
 *
 * ## What it replaces
 *
 * The member editor rendered `ALL_PERMISSIONS` as a single flat grid of ~40
 * unlabelled-by-risk checkboxes, over a `PERMISSION_LABELS` map it kept
 * privately. That had four problems, and this component exists to fix all
 * four rather than to look nicer:
 *
 *   1. **No grouping.** Finding «بازگشت وجه» meant reading the whole list.
 *   2. **No risk signal.** Granting «مشاهدهٔ منو» and granting «بازیابی
 *      پشتیبان» were the same visual act, so nothing told an owner that one of
 *      those two replaces their entire database.
 *   3. **No provenance.** A tick meant "this member has it", with no way to see
 *      whether it came from the role or was granted to them personally — which
 *      is exactly the question an owner reviewing access is asking. Saving
 *      re-derived grants and revokes by diffing against the preset, so the
 *      distinction existed in the data and was invisible in the UI.
 *   4. **Duplicate metadata.** The labels lived here; anything else that needed
 *      to name a permission wrote its own copy.
 *
 * Everything it renders now comes from `permission-registry.ts`, so a
 * permission added there appears here — correctly grouped, labelled,
 * risk-marked and with its dependencies wired — without this file changing.
 *
 * ## Dependencies are enforced, not suggested
 *
 * Ticking «اصلاح موجودی» ticks «مشاهدهٔ انبار» too, because a role that can
 * adjust stock it cannot see is a support ticket, not a configuration. Unticking
 * a permission that others depend on unticks those as well, for the same reason.
 */
import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  PERMISSION_GROUP_ORDER,
  PERMISSION_METADATA,
  impliedPermissions,
  isDangerousPermission,
  permissionGroupLabel,
  permissionsInGroup,
  type PermissionGroup,
  type PermissionMetadata,
} from "@/lib/permission-registry";
import { isOwnerOnlyPermission, type Permission } from "@/lib/permissions";
import { inputClass } from "@/app/dashboard/ui";

/** Where a member's hold on a permission comes from — the Access tab's question. */
export type PermissionSource = "role" | "granted" | "revoked" | "none";

export function permissionSource(
  key: Permission,
  preset: ReadonlySet<string>,
  selected: ReadonlySet<string>,
): PermissionSource {
  const inPreset = preset.has(key);
  const held = selected.has(key);
  if (inPreset && held) return "role";
  if (!inPreset && held) return "granted";
  if (inPreset && !held) return "revoked";
  return "none";
}

const SOURCE_BADGE: Record<Exclude<PermissionSource, "none">, { label: string; className: string }> = {
  role: { label: "از نقش", className: "bg-muted text-muted-foreground" },
  granted: { label: "افزوده", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  revoked: { label: "گرفته‌شده", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
};

const RISK_LABEL: Record<PermissionMetadata["risk"], string> = {
  low: "کم",
  medium: "متوسط",
  high: "پرخطر",
  critical: "بحرانی",
};

export interface PermissionEditorProps {
  /** The role's default set — what a tick "from the role" means. */
  preset: ReadonlySet<string>;
  /** Currently-held permissions (preset ∪ granted \ revoked). */
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** Read-only rendering, for the Access tab of a member profile. */
  readOnly?: boolean;
}

export function PermissionEditor({ preset, selected, onChange, readOnly }: PermissionEditorProps) {
  const [term, setTerm] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const needle = term.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return null;
    return new Set(
      Object.values(PERMISSION_METADATA)
        .filter((m) =>
          [m.key, m.label, m.description, m.group, permissionGroupLabel(m.group)]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
        .map((m) => m.key),
    );
  }, [needle]);

  /**
   * Applying a change also applies its consequences: turning a permission on
   * turns on everything it implies, and turning one off turns off everything
   * that implies it. Doing this at the point of change rather than at save time
   * means the editor never *displays* a set it would not actually store.
   */
  function apply(key: Permission, checked: boolean) {
    if (readOnly) return;
    const next = new Set(selected);
    if (checked) {
      next.add(key);
      for (const implied of impliedPermissions([key])) next.add(implied);
    } else {
      next.delete(key);
      for (const other of Object.values(PERMISSION_METADATA)) {
        if (next.has(other.key) && impliedPermissions([other.key]).includes(key)) {
          next.delete(other.key);
        }
      }
    }
    onChange(next);
  }

  /** Group-level convenience: none / view-only / everything in the group. */
  function applyGroup(group: PermissionGroup, mode: "none" | "view" | "all") {
    if (readOnly) return;
    const keys = permissionsInGroup(group)
      .map((m) => m.key)
      .filter((k) => !isOwnerOnlyPermission(k));
    const next = new Set(selected);
    for (const key of keys) next.delete(key);
    if (mode !== "none") {
      const wanted =
        mode === "all" ? keys : keys.filter((k) => PERMISSION_METADATA[k].risk === "low");
      for (const key of wanted) {
        next.add(key);
        for (const implied of impliedPermissions([key])) next.add(implied);
      }
    }
    onChange(next);
  }

  const groups = PERMISSION_GROUP_ORDER.map((group) => ({
    group,
    items: permissionsInGroup(group).filter(
      (m) => !isOwnerOnlyPermission(m.key) && (!matches || matches.has(m.key)),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass} flex-1 min-w-48`}
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="جست‌وجو در دسترسی‌ها…"
          aria-label="جست‌وجو در دسترسی‌ها"
        />
        {!readOnly ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={advanced}
              onCheckedChange={(checked) => setAdvanced(checked === true)}
            />
            <span>نمایش کلید فنی</span>
          </label>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          دسترسی‌ای با این عبارت پیدا نشد.
        </p>
      ) : null}

      {groups.map(({ group, items }) => (
        <section key={group} className="rounded-lg border">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
            <h4 className="text-sm font-medium">{permissionGroupLabel(group)}</h4>
            {!readOnly ? (
              <div className="flex items-center gap-1">
                {(
                  [
                    ["none", "بدون دسترسی"],
                    ["view", "فقط مشاهده"],
                    ["all", "کامل"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyGroup(group, mode)}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-background hover:text-foreground"
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </header>

          <ul className="divide-y">
            {items.map((meta) => {
              const source = permissionSource(meta.key, preset, selected);
              const badge = source === "none" ? null : SOURCE_BADGE[source];
              const dangerous = isDangerousPermission(meta.key);
              return (
                <li key={meta.key} className="flex items-start gap-3 px-3 py-2">
                  <Checkbox
                    className="mt-1"
                    checked={selected.has(meta.key)}
                    disabled={readOnly}
                    onCheckedChange={(checked) => apply(meta.key, checked === true)}
                    aria-label={meta.label}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{meta.label}</span>
                      {dangerous ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[11px] ${
                            meta.risk === "critical"
                              ? "bg-destructive/15 text-destructive"
                              : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                          }`}
                        >
                          {RISK_LABEL[meta.risk]}
                        </span>
                      ) : null}
                      {badge ? (
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${badge.className}`}>
                          {badge.label}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">{meta.description}</p>
                    {advanced ? (
                      <code className="text-[11px] text-muted-foreground/80">{meta.key}</code>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The change an owner is about to save, in words.
 *
 * Shown before saving because "you are also removing this person's ability to
 * take payments" is not something anybody should discover from a support call.
 * Returns `null` when nothing changed, so the caller can omit the summary
 * entirely rather than render an empty box.
 */
export function accessChangeSummary(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): { added: PermissionMetadata[]; removed: PermissionMetadata[] } | null {
  const added = [...after]
    .filter((k) => !before.has(k))
    .map((k) => PERMISSION_METADATA[k as Permission])
    .filter(Boolean);
  const removed = [...before]
    .filter((k) => !after.has(k))
    .map((k) => PERMISSION_METADATA[k as Permission])
    .filter(Boolean);
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/** The impact summary, rendered. Used by the member editor before saving. */
export function AccessChangeSummary({
  before,
  after,
}: {
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
}) {
  const summary = accessChangeSummary(before, after);
  if (!summary) return null;
  const dangerous = [...summary.added, ...summary.removed].some((m) =>
    isDangerousPermission(m.key),
  );
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        dangerous ? "border-amber-500/50 bg-amber-500/5" : "bg-muted/40"
      }`}
    >
      <p className="mb-1 font-medium">خلاصهٔ تغییر دسترسی</p>
      {summary.added.length > 0 ? (
        <p className="text-emerald-700 dark:text-emerald-400">
          افزوده: {summary.added.map((m) => m.label).join("، ")}
        </p>
      ) : null}
      {summary.removed.length > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          گرفته‌شده: {summary.removed.map((m) => m.label).join("، ")}
        </p>
      ) : null}
    </div>
  );
}
