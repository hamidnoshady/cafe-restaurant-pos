/**
 * Chart-of-accounts presentation rules — the framework-free half of
 * «سرفصل حساب‌ها».
 *
 * The screen used to render `listAccounts`' output exactly as Postgres
 * returned it: one flat list, `ORDER BY code`, with the parent shown as a bare
 * code in its own column. That reads as a spreadsheet, not as a chart of
 * accounts — the گروه/کل/معین/تفصیلی structure the whole model is built around
 * (migration 0056) was invisible unless you happened to know that 5310's
 * parent is 5300, and a sub-account whose code does not sort next to its
 * parent's (perfectly legal — `code` is free text) appeared nowhere near it.
 *
 * So the ordering and the search matching live here, pure and tested, instead
 * of inline in a client component:
 *
 *  - `buildAccountTree` walks parents before children, siblings in code order,
 *    and reports each row's real depth in the parent chain — so the list reads
 *    top-down like the chart it is, whatever the codes say.
 *  - `collectDescendantIds` answers "what would move with this account", which
 *    is what the edit form needs to stop offering a parent the server is bound
 *    to reject with `parent_cycle`.
 *  - `matchesAccountSearch` normalises Persian/Arabic digits and the ی/ك
 *    variants the same way every other search box in the product does, so
 *    typing «۶۱۰۰» finds account 6100.
 *
 * Every function tolerates broken data rather than trusting it: an account
 * whose parent is missing is treated as a root, and a cycle (which
 * `assertNoCycle` prevents at write time, but nothing enforces in the schema)
 * is broken by a visited set instead of hanging the browser.
 */

import { normalizePosSearchText } from "./pos-selection";
import { PERMISSIONS } from "./permissions";

/** The minimum an account row needs for any of this to apply. */
export interface AccountNodeLike {
  id: string;
  code: string;
  parentId: string | null;
}

export interface AccountTreeRow<T extends AccountNodeLike> {
  account: T;
  /** Steps from the top of the chart — 0 for a root, capped only by the data. */
  depth: number;
}

/**
 * Account codes compared the way a person reads them: numerically when they
 * are numbers, so 1100 sorts before 1300 and «۹۹» never lands before «۱۰۰»,
 * and lexically when a business uses a non-numeric scheme.
 */
export function compareAccountCodes(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

/**
 * Parents before children, siblings in code order, each row carrying its depth.
 *
 * Accounts whose `parentId` points at something not in the list are roots:
 * that happens legitimately (a filtered list) and illegitimately (bad data),
 * and hiding the row in either case would be worse than showing it at the top
 * level. Anything left unvisited after the walk — only reachable if the data
 * contains a cycle — is appended at depth 0 so no account can disappear from
 * its own management screen.
 */
export function buildAccountTree<T extends AccountNodeLike>(accounts: readonly T[]): AccountTreeRow<T>[] {
  const byId = new Map<string, T>(accounts.map((account) => [account.id, account]));
  const childrenByParent = new Map<string | null, T[]>();

  for (const account of accounts) {
    // A parent outside this list is no parent at all, for ordering purposes.
    const parentKey = account.parentId && byId.has(account.parentId) ? account.parentId : null;
    const siblings = childrenByParent.get(parentKey);
    if (siblings) siblings.push(account);
    else childrenByParent.set(parentKey, [account]);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => compareAccountCodes(a.code, b.code));
  }

  const rows: AccountTreeRow<T>[] = [];
  const visited = new Set<string>();

  const walk = (parentKey: string | null, depth: number): void => {
    for (const account of childrenByParent.get(parentKey) ?? []) {
      if (visited.has(account.id)) continue;
      visited.add(account.id);
      rows.push({ account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk(null, 0);

  if (visited.size < accounts.length) {
    for (const account of accounts) {
      if (visited.has(account.id)) continue;
      visited.add(account.id);
      rows.push({ account, depth: 0 });
    }
  }

  return rows;
}

/**
 * Every account below `rootId`, at any depth — the subtree that travels with
 * an account when it is reparented, and therefore exactly the set that may
 * never become its new parent.
 */
export function collectDescendantIds(accounts: readonly AccountNodeLike[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const account of accounts) {
    if (!account.parentId) continue;
    const siblings = childrenByParent.get(account.parentId);
    if (siblings) siblings.push(account.id);
    else childrenByParent.set(account.parentId, [account.id]);
  }

  const descendants = new Set<string>();
  const queue = [...(childrenByParent.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.pop()!;
    // The visited check is the cycle guard: `accounts.parent_id` has no
    // DB-level one (see migration 0056's note), only assertNoCycle.
    if (descendants.has(id) || id === rootId) continue;
    descendants.add(id);
    for (const child of childrenByParent.get(id) ?? []) queue.push(child);
  }
  return descendants;
}

/**
 * The text one account is searched by. Everything the row displays is
 * searchable — a person looking at a «هزینه» column expects typing «هزینه» to
 * narrow the list, and the parent code is what makes "show me 5300's family"
 * work at all.
 */
export function accountSearchHaystack(parts: readonly (string | null | undefined)[]): string {
  return normalizePosSearchText(parts.filter(Boolean).join(" "));
}

/**
 * Does this (already normalised) haystack match what was typed?
 *
 * The query is normalised here rather than by the caller so digits, the ی/ك
 * variants and casing are handled identically on both sides — that is the
 * whole reason «۶۱۰۰» has to find account 6100. Every whitespace-separated
 * term must match, so «نقد بانک» narrows instead of widening.
 */
export function matchesAccountSearch(haystack: string, query: string): boolean {
  const normalized = normalizePosSearchText(query);
  if (!normalized) return true;
  return normalized.split(" ").every((term) => haystack.includes(term));
}

/**
 * The roles whose *presets* may edit the chart — the fallback for a mount that
 * could not read the member's effective permissions. Mirrors `ROLE_PRESETS` in
 * permissions.ts (`accountsEdit` sits with owner and accountant; a manager may
 * open every accounting section but not restructure the chart).
 */
export const COA_PRESET_EDITING_ROLES: readonly string[] = ["owner", "accountant"];

/**
 * May this member edit the chart of accounts?
 *
 * The real answer when their effective permissions are known, the preset
 * answer when they are not — the same shape `partiesSectionAbilities` uses,
 * for the same reason. The API enforces `accounts.edit` on every mutating
 * route regardless; this only decides which buttons are drawn, so a manager
 * is not shown «حذف» and «بایگانی» controls that could only ever answer 403.
 */
export function canEditChartOfAccounts(
  role: string | null | undefined,
  permissions?: readonly string[] | null,
): boolean {
  if (permissions !== undefined && permissions !== null) return permissions.includes(PERMISSIONS.accountsEdit);
  return COA_PRESET_EDITING_ROLES.includes(role ?? "");
}
