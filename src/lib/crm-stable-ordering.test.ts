/**
 * Every CRM list query sorts by a total order.
 *
 * ## The bug this prevents
 *
 * `ORDER BY updated_at DESC` alone is a *partial* order. When two rows share
 * the sort value — deals seeded together, activities created by one import,
 * notes typed in the same second — Postgres may return them in any sequence,
 * and is free to choose a different one for the same query on the next call
 * (a different plan, a different scan direction, a row moved by an update).
 *
 * The visible symptoms are small and confusing: kanban cards swap places on a
 * refresh nobody triggered, a list paginates with a row appearing on two pages
 * or on neither. It cost a red `crm-deals` visual baseline, whose three
 * fixture deals are all inserted with an identical timestamp — the check was
 * right, and the flake was real.
 *
 * ## Why a source test rather than a database test
 *
 * Non-determinism cannot be demonstrated by running the query: a stable plan
 * returns the same order every time on a small table, so a passing integration
 * test would prove nothing and would keep passing right up until production
 * data changed the plan. The property is structural — *the ORDER BY ends in a
 * unique column* — so it is checked structurally.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./crm-service.ts", import.meta.url)),
  "utf8",
);

/**
 * Pull out every ORDER BY clause, with SQL comments stripped.
 *
 * A clause runs to the next SQL keyword that can follow it, the end of the
 * template literal, or the closing backtick.
 */
function orderByClauses(source: string): string[] {
  const withoutSqlComments = source.replace(/--[^\n]*/g, "");
  const matches = withoutSqlComments.matchAll(
    /ORDER BY([\s\S]*?)(?=\bLIMIT\b|\bFOR UPDATE\b|`|\$\{params\.length\})/gi,
  );
  return [...matches].map((m) => m[1].replace(/\s+/g, " ").trim()).filter(Boolean);
}

describe("CRM list ordering is deterministic", () => {
  it("finds the ORDER BY clauses it means to check", () => {
    // A guard on the guard: if the extraction silently matched nothing, every
    // assertion below would pass vacuously and the rule would be decorative.
    expect(orderByClauses(SOURCE).length).toBeGreaterThanOrEqual(5);
  });

  it("ends every ORDER BY with a unique column", () => {
    const offenders = orderByClauses(SOURCE).filter((clause) => {
      const last = clause.split(",").pop()?.trim().toLowerCase() ?? "";
      // `id` is the primary key, alone or qualified (`d.id`). Anything else as
      // the final term leaves ties unresolved.
      return !/^(?:[a-z_]+\.)?id\b/.test(last);
    });

    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `These ORDER BY clauses do not end in a unique column, so rows with equal sort keys come back in an arbitrary order:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
