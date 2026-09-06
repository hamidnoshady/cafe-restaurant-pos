"use client";

/**
 * The party directory — the section every app mounts for «طرف‌حساب‌ها».
 *
 * There is exactly one of this component in the platform, and it is mounted four
 * times: the CRM's customers, the store's suppliers, the team's personnel, and
 * Accounting's whole file. Which rows appear, which columns are drawn, and whether
 * a row can be edited at all is answered by `PARTY_SCOPES`
 * (`src/lib/parties-scopes.ts`), never by a copy of this list in the app.
 *
 * What a section may *not* do is the other half of the rule. No app keeps its own
 * add/edit form, its own inactive flag, or its own second table of "the suppliers I
 * care about": Inventory used to have all three, and the ledger had a fourth
 * opinion of who a supplier is. Every one of those screens mounts this component
 * with its scope, so a name changed here is a name changed everywhere — the only
 * promise a shared record has to keep.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import {
  PARTY_COLUMN_LABELS,
  partyOwnerScopeForRole,
  roleLabelInScope,
  showsColumn,
  type PartyColumn,
  type PartyScopeDef,
} from "@/lib/parties-scopes";
import { PARTY_ROLE_LABELS, type PartyApiRecord, type PartyRole } from "@/lib/parties";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";
import { api, errorMessage, ErrorBox, Field, InfoBox, inputClass } from "../ui";
import { ArStatementPanel } from "../ledger/ar-statement-panel";
import { crmCustomerHref } from "../crm/crm-routes";
import { PartyFormDialog } from "./party-form";

const PAGE_SIZE = 20;

/**
 * The roles that may write a party *from a screen*. The permission itself is
 * `parties.manage` and the API is the gate — this list only decides whether a
 * button is drawn at all, and it mirrors the presets in `permissions.ts` so a
 * cashier sees «افزودن مشتری» in the CRM and a waiter does not.
 */
const MANAGING_ROLES = ["owner", "manager", "cashier", "accountant"] as const;

interface CategoryRow {
  id: string;
  name: string;
  role: string | null;
  isActive: boolean;
}

/** A row as the section needs it: the API's `Party`, narrowed to what the columns draw. */
export interface PartyListRow extends PartyApiRecord {
  id: string;
  displayName: string;
  /** The one column the list draws that a party record does not carry by itself. */
  categoryName?: string | null;
}

export interface PartiesSectionProps {
  /** The app's view: roles, columns, edit rights. */
  scope: PartyScopeDef;
  /** The signed-in role — decides which buttons exist and whether ledger figures show. */
  role: string;
  /** Opens one party's form on mount — the deep link another app's row uses. */
  editPartyId?: string | null;
  /** Opens the create form on mount — an overview quick action that only says "add one". */
  openNewOnMount?: boolean;
}

export function PartiesSection({ scope, role, editPartyId, openNewOnMount }: PartiesSectionProps) {
  const canManage = !scope.readOnly && (MANAGING_ROLES as readonly string[]).includes(role);
  // Money-shaped columns follow the ledger's own access rule, not the section's: a
  // cashier browsing customers is not a cashier reading balances.
  const canSeeLedger = role === "owner" || role === "manager" || role === "accountant";

  const [parties, setParties] = useState<PartyListRow[] | null>(null);
  /**
   * The business the listing came from, and so the namespace of its drafts. Read
   * off the response rather than passed in: every mount of this section is a
   * different app's client component, and a prop each of them must remember to
   * thread would be a mount that silently shares one browser's drafts across two
   * businesses on a pre-Phase-23 origin.
   */
  const [businessId, setBusinessId] = useState("");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [showCategories, setShowCategories] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ partyId?: string | null; initial?: PartyApiRecord | null } | null>(
    editPartyId ? { partyId: editPartyId } : openNewOnMount ? {} : null,
  );
  const [statement, setStatement] = useState<{ id: string; name: string } | null>(null);
  /**
   * What each party owes, read from the ledger's own receivables endpoint when this
   * scope asks for the column (`balance`) and this role may see accounting figures.
   * The number is the ledger's, never a copy: the directory shows it and links to
   * the statement, and that is all a second app is allowed to do with a balance.
   */
  const [balances, setBalances] = useState<Record<string, number>>({});
  const money = useMoney();

  const columns = useMemo(
    () => scope.columns.filter((column: PartyColumn) => showsColumn(scope, column)),
    [scope],
  );

  useEffect(() => setPage(1), [query, includeInactive, categoryId]);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    params.set("roles", scope.roles.join(","));
    if (query.trim()) params.set("q", query.trim());
    if (includeInactive) params.set("includeInactive", "1");
    if (categoryId) params.set("categoryId", categoryId);
    void api<{ parties: PartyListRow[]; total: number; businessId?: string; error?: string }>(
      `/api/parties?${params}`,
    ).then(({ ok, data }) => {
      if (ok) {
        setParties(data.parties ?? []);
        setTotal(Number(data.total ?? 0));
        setBusinessId(data.businessId ?? "");
      } else {
        setParties([]);
        setError(errorMessage(data.error));
      }
    });
  }, [page, query, includeInactive, categoryId, refreshKey, scope]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!canSeeLedger || !columns.includes("balance")) {
      setBalances({});
      return;
    }
    void api<{ customers: { customerId: string; balance: number }[] }>("/api/ledger/ar/customers").then(
      ({ ok, data }) => {
        if (ok) setBalances(Object.fromEntries((data.customers ?? []).map((row) => [row.customerId, row.balance])));
      },
    );
  }, [canSeeLedger, columns, refreshKey]);

  const loadCategories = useCallback(() => {
    void api<{ categories: CategoryRow[] }>("/api/parties/categories?includeInactive=1").then(({ ok, data }) => {
      if (ok) setCategories(data.categories ?? []);
    });
  }, [refreshKey]);
  useEffect(loadCategories, [loadCategories]);

  async function run(action: () => Promise<{ ok: boolean; data: { error?: string } }>, successInfo = "") {
    setBusy(true);
    setError("");
    const { ok, data } = await action();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    if (successInfo) setInfo(successInfo);
    setRefreshKey((key) => key + 1);
    return true;
  }

  /**
   * The status toggle sends `status` alone.
   *
   * That is only safe because the route is patch-shaped: a body that names one key
   * changes one key. A form-shaped PUT (which the party form also uses) would
   * archive a party and blank its address in the same statement.
   */
  async function toggleStatus(party: PartyListRow) {
    await run(() =>
      api(`/api/parties/${encodeURIComponent(party.id)}`, {
        method: "PUT",
        body: JSON.stringify({ status: party.status === false }),
      }),
    );
  }

  async function remove(party: PartyListRow) {
    if (!window.confirm(`آیا از حذف «${party.displayName}» مطمئن هستید؟`)) return;
    setInfo("");
    setBusy(true);
    const { ok, data } = await api<{ result?: "deleted" | "archived"; error?: string }>(
      `/api/parties/${encodeURIComponent(party.id)}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      data.result === "archived"
        ? "این طرف‌حساب سابقهٔ مالی یا شعبه‌ای دارد؛ برای حفظ صورتحساب‌ها به‌جای حذف، بایگانی شد."
        : "طرف‌حساب حذف شد.",
    );
    setRefreshKey((key) => key + 1);
  }

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const addLabel =
    scope.roles.length > 1 ? "افزودن طرف‌حساب" : `افزودن ${PARTY_ROLE_LABELS[scope.defaultRole]}`;
  const emptyLabel =
    scope.roles.length > 1 ? "طرف‌حسابی پیدا نشد." : `${PARTY_ROLE_LABELS[scope.defaultRole]} ای پیدا نشد.`;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">{scope.description}</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">{scope.label}</h2>
          </div>
        }
        description={
          scope.readOnly
            ? "نمای خواندنی از پروندهٔ مشترک؛ ویرایش در بخش مالک این رکورد انجام می‌شود."
            : canManage
              ? "روی هر ردیف بزنید تا پروندهٔ کاملش باز شود."
              : "در این بخش فقط خوانده می‌شود؛ برای ویرایش، دسترسی «مدیریت طرف‌حساب‌ها» لازم است."
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCategories(true)}>
              دسته‌ها
            </Button>
            {canManage ? (
              <Button type="button" onClick={() => setForm({})}>{addLabel}</Button>
            ) : null}
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            className={`${inputClass} w-full sm:w-56`}
            placeholder="جستجو با نام یا تلفن…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {categories.length > 0 ? (
            <select
              className={`${inputClass} w-auto`}
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">همهٔ دسته‌ها</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeInactive}
              onCheckedChange={(checked) => setIncludeInactive(checked === true)}
            />
            نمایش بایگانی‌شده‌ها
          </label>
        </div>

        {!parties ? (
          <LoadingSkeleton rows={3} />
        ) : parties.length === 0 ? (
          <EmptyState>{emptyLabel}</EmptyState>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/80 text-muted-foreground">
                    {columns.map((column) => (
                      <th key={column} className="py-2 pe-3 text-start font-medium">
                        {PARTY_COLUMN_LABELS[column]}
                      </th>
                    ))}
                    {canManage ? <th className="py-2 text-start font-medium">عملیات</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {parties.map((party) => (
                    <tr
                      key={party.id}
                      className="border-b border-border/80 transition-colors hover:bg-stone-50/70 dark:hover:bg-muted/50"
                    >
                      {columns.map((column) => (
                        <td key={column} className="py-3 pe-3 align-top">
                          <PartyCell
                            column={column}
                            party={party}
                            scope={scope}
                            showRoleChip={scope.roles.length > 1}
                            showLedger={canSeeLedger}
                            balance={balances[party.id]}
                            formatMoney={(value) => money.format(value)}
                          />
                        </td>
                      ))}
                      {canManage ? (
                        <td className="py-3 align-top">
                          <PartyRowActions
                            party={party}
                            busy={busy}
                            canSeeStatement={canSeeLedger && scope.key !== "accounting"}
                            onEdit={() => setForm({ partyId: party.id, initial: party })}
                            onToggleStatus={() => toggleStatus(party)}
                            onRemove={() => remove(party)}
                            onStatement={() => setStatement({ id: party.id, name: party.displayName })}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {parties.map((party) => (
                <div
                  key={party.id}
                  className="rounded-xl border border-border/80 bg-muted/50 p-4 transition-colors hover:bg-muted"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground">{party.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[
                          roleLabelInScope(scope, party.role as PartyRole),
                          party.phone ? toPersianDigits(party.phone) : null,
                          party.categoryName,
                          party.accountingCode ? `کد ${toPersianDigits(party.accountingCode)}` : null,
                          canSeeLedger && balances[party.id]
                            ? `مانده حساب: ${money.format(balances[party.id])}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "بدون توضیح"}
                      </p>
                    </div>
                    <StatusBadge tone={party.status === false ? "neutral" : "positive"}>
                      {party.status === false ? "بایگانی" : "فعال"}
                    </StatusBadge>
                  </div>
                  {canManage ? (
                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/80 pt-2">
                      <PartyRowActions
                        party={party}
                        busy={busy}
                        canSeeStatement={canSeeLedger && scope.key !== "accounting"}
                        onEdit={() => setForm({ partyId: party.id, initial: party })}
                        onToggleStatus={() => toggleStatus(party)}
                        onRemove={() => remove(party)}
                        onStatement={() => setStatement({ id: party.id, name: party.displayName })}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPage((current) => Math.max(current - 1, 1))}
                    disabled={page <= 1}
                  >
                    قبلی
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setPage((current) => Math.min(current + 1, totalPages))}
                    disabled={page >= totalPages}
                  >
                    بعدی
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </SectionCard>

      {form ? (
        <PartyFormDialog
          scope={scope}
          partyId={form.partyId ?? null}
          initial={form.initial ?? null}
          businessId={businessId}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setInfo("طرف‌حساب ذخیره شد.");
            setRefreshKey((key) => key + 1);
          }}
        />
      ) : null}

      {showCategories ? (
        <PartyCategoriesDialog
          categories={categories}
          canManage={canManage}
          busy={busy}
          run={run}
          onClose={() => setShowCategories(false)}
        />
      ) : null}

      {/*
        The A/R statement is the ledger's own panel, opened for the members who may
        see accounting figures — the CRM and the sales screens read that balance,
        they do not restate it. Same rule as before the rename, same component.
      */}
      {statement ? (
        <ArStatementPanel
          customerId={statement.id}
          customerName={statement.name}
          onClose={() => setStatement(null)}
        />
      ) : null}
    </div>
  );
}

function PartyCell({
  column,
  party,
  scope,
  showRoleChip,
  showLedger,
  balance,
  formatMoney,
}: {
  column: PartyColumn;
  party: PartyListRow;
  scope: PartyScopeDef;
  showRoleChip: boolean;
  /** Whether this role may read the ledger's figures on a party at all. */
  showLedger: boolean;
  balance?: number;
  formatMoney: (value: number) => string;
}) {
  switch (column) {
    case "displayName":
      return (
        <span className="font-medium text-foreground">
          {scope.readOnly ? (
            <Link
              href={partyOwnerScopeForRole((party.role as PartyRole) ?? scope.defaultRole).href}
              className="inline-flex items-center gap-1 hover:underline"
            >
              {party.displayName}
              <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden="true" />
            </Link>
          ) : scope.key === "crm" ? (
            <Link href={crmCustomerHref(party.id)} className="hover:underline">
              {party.displayName}
            </Link>
          ) : (
            party.displayName
          )}
        </span>
      );
    case "role":
      return showRoleChip ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {PARTY_ROLE_LABELS[(party.role as PartyRole) ?? "Customer"]}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case "phone":
      return <span className="text-muted-foreground">{party.phone ? toPersianDigits(party.phone) : "—"}</span>;
    case "email":
      return <span className="text-muted-foreground">{party.email || "—"}</span>;
    case "city":
      return <span className="text-muted-foreground">{party.addressInfo?.city || "—"}</span>;
    case "category":
      return <span className="text-muted-foreground">{party.categoryName || "—"}</span>;
    case "accountingCode":
      return (
        <span className="tabular-nums text-muted-foreground">
          {party.accountingCode ? toPersianDigits(party.accountingCode) : "—"}
        </span>
      );
    case "tax": {
      const tax = party.generalInfo?.taxPercentage;
      return (
        <span className="tabular-nums text-muted-foreground">
          {typeof tax === "number" && showLedger ? `${toPersianDigits(String(tax))}٪` : "—"}
        </span>
      );
    }
    case "balance":
      return (
        <span className="tabular-nums font-semibold">
          {showLedger && balance ? formatMoney(balance) : "—"}
        </span>
      );
    case "status":
    default:
      return (
        <StatusBadge tone={party.status === false ? "neutral" : "positive"}>
          {party.status === false ? "بایگانی" : "فعال"}
        </StatusBadge>
      );
  }
}

function PartyRowActions({
  party,
  busy,
  canSeeStatement,
  onEdit,
  onToggleStatus,
  onRemove,
  onStatement,
}: {
  party: PartyListRow;
  busy: boolean;
  canSeeStatement: boolean;
  onEdit: () => void;
  onToggleStatus: () => void;
  onRemove: () => void;
  onStatement: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      <Button type="button" variant="ghost" size="xs" onClick={onEdit}>
        ویرایش
      </Button>
      {canSeeStatement ? (
        <Button type="button" variant="ghost" size="xs" onClick={onStatement} className="text-muted-foreground">
          صورتحساب
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onToggleStatus} className="text-muted-foreground">
        {party.status === false ? "فعال‌سازی" : "بایگانی"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={busy}
        onClick={onRemove}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        حذف
      </Button>
    </div>
  );
}

/**
 * The category panel.
 *
 * It lives beside the list rather than in a settings screen because a category is
 * not a preference: it is a fact about the parties on this page, edited while the
 * list is open, and a second place to keep the same fact is where two apps start
 * disagreeing about it.
 */
function PartyCategoriesDialog({
  categories,
  canManage,
  busy,
  run,
  onClose,
}: {
  categories: CategoryRow[];
  canManage: boolean;
  busy: boolean;
  run: (action: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>دسته‌های طرف‌حساب‌ها</DialogTitle>
        </DialogHeader>
        <p className="mb-3 text-xs text-muted-foreground">
          دسته‌ها برای همین فهرست‌اند: یک گروه می‌تواند فقط برای مشتریان باشد، فقط برای تأمین‌کنندگان، یا برای هر سه.
        </p>
        {canManage ? (
          <div className="mb-2 grid min-w-0 gap-2 sm:grid-cols-[1fr_8rem_auto]">
            <Field label="نام دسته">
              <input className={inputClass} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="نقش">
              <select className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}>
                <option value="">همه</option>
                {(["Customer", "Employee", "Supplier"] as const).map((partyRole) => (
                  <option key={partyRole} value={partyRole}>
                    {PARTY_ROLE_LABELS[partyRole]}
                  </option>
                ))}
              </select>
            </Field>
            <div className="flex items-end">
              <Button
                type="button"
                disabled={busy || !name.trim()}
                onClick={() =>
                  run(async () => {
                    const result = await api("/api/parties/categories", {
                      method: "POST",
                      body: JSON.stringify({ name: name.trim(), role: role || null }),
                    });
                    if (result.ok) setName("");
                    return result;
                  })
                }
              >
                افزودن
              </Button>
            </div>
          </div>
        ) : null}
        <ul className="divide-y divide-border/80">
          {categories.map((category) => (
            <li key={category.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className={category.isActive ? "" : "text-muted-foreground line-through"}>
                {category.name}
                {category.role ? (
                  <span className="ms-2 text-xs text-muted-foreground">
                    {PARTY_ROLE_LABELS[category.role as PartyRole] ?? ""}
                  </span>
                ) : null}
              </span>
              {canManage && category.isActive ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-muted-foreground"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      api(`/api/parties/categories/${category.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: false }),
                      }),
                    )
                  }
                >
                  غیرفعال‌سازی
                </Button>
              ) : null}
            </li>
          ))}
          {categories.length === 0 ? (
            <li className="py-3 text-sm text-muted-foreground">دسته‌ای ساخته نشده است.</li>
          ) : null}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            بستن
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
