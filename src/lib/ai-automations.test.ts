import { describe, expect, it } from "vitest";
import {
  automationErrorMessage,
  evaluateConditions,
  selectableAutomationActions,
  validateAutomation,
  type AutomationFacts,
} from "./ai-automations";
import { ACTION_CATALOG } from "./ai";

const facts: AutomationFacts = {
  receivableTotalRial: 6_000_000,
  payableTotalRial: 1_000_000,
  stockValuationRial: 40_000_000,
  weekday: 3,
  hour: 9,
};

describe("Phase D — automation condition evaluator", () => {
  it("an empty document always matches", () => {
    expect(evaluateConditions({}, facts)).toBe(true);
  });

  it("all-of is AND", () => {
    expect(
      evaluateConditions(
        { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
        facts,
      ),
    ).toBe(true);
    expect(
      evaluateConditions(
        {
          all: [
            { field: "receivableTotalRial", op: "gte", value: 5_000_000 },
            { field: "payableTotalRial", op: "gte", value: 5_000_000 },
          ],
        },
        facts,
      ),
    ).toBe(false);
  });

  it("any-of is OR", () => {
    expect(
      evaluateConditions(
        {
          any: [
            { field: "payableTotalRial", op: "gte", value: 5_000_000 },
            { field: "stockValuationRial", op: "gte", value: 5_000_000 },
          ],
        },
        facts,
      ),
    ).toBe(true);
  });

  it("all-of AND any-of together", () => {
    expect(
      evaluateConditions(
        {
          all: [{ field: "weekday", op: "eq", value: 3 }],
          any: [
            { field: "hour", op: "lte", value: 6 },
            { field: "hour", op: "gte", value: 8 },
          ],
        },
        facts,
      ),
    ).toBe(true);
    // all-of fails => whole doc fails even though any-of holds
    expect(
      evaluateConditions(
        {
          all: [{ field: "weekday", op: "eq", value: 5 }],
          any: [{ field: "hour", op: "gte", value: 8 }],
        },
        facts,
      ),
    ).toBe(false);
  });
});

describe("Phase D — automation validation", () => {
  const base = {
    name: "یادآور مطالبات",
    triggerKind: "schedule",
    scheduleHour: 9,
    actionType: "journal.manual.propose",
  };

  it("accepts a well-formed scheduled automation", () => {
    const result = validateAutomation({
      ...base,
      conditions: { all: [{ field: "receivableTotalRial", op: "gte", value: 5_000_000 }] },
      actionPayload: { note: "بررسی مطالبات" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.triggerKind).toBe("schedule");
    expect(result.value.scheduleHour).toBe(9);
    expect(result.value.conditions.all?.length).toBe(1);
    expect(result.value.approvalMode).toBe("ask");
  });

  it("enforces the trigger shape — a schedule needs an hour, an event needs a kind", () => {
    expect(validateAutomation({ ...base, scheduleHour: undefined }).ok).toBe(false);
    const event = validateAutomation({
      name: "x",
      triggerKind: "event",
      eventKind: "day_close",
      actionType: "journal.manual.propose",
    });
    expect(event.ok).toBe(true);
    const badEvent = validateAutomation({
      name: "x",
      triggerKind: "event",
      eventKind: "not_a_real_event",
      actionType: "journal.manual.propose",
    });
    expect(badEvent.ok).toBe(false);
    if (!badEvent.ok) expect(badEvent.errors).toContain("invalid_event_kind");
  });

  it("rejects an unknown condition field and operator, never ignores them", () => {
    const badField = validateAutomation({
      ...base,
      conditions: { all: [{ field: "totally_made_up", op: "gte", value: 1 }] },
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.errors.some((e) => e.startsWith("unknown_field:"))).toBe(true);

    const badOp = validateAutomation({
      ...base,
      conditions: { all: [{ field: "hour", op: "between", value: 1 }] },
    });
    expect(badOp.ok).toBe(false);
    if (!badOp.ok) expect(badOp.errors.some((e) => e.startsWith("unknown_operator:"))).toBe(true);
  });

  it("rejects an unknown action and every coworker-only action", () => {
    const bad = validateAutomation({ ...base, actionType: "not.an.action" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("unknown_action:not.an.action");

    const coworkerOnly = Object.keys(ACTION_CATALOG).find(
      (type) => ACTION_CATALOG[type as keyof typeof ACTION_CATALOG].coworkerOnly,
    )!;
    const result = validateAutomation({ ...base, actionType: coworkerOnly });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(`unknown_action:${coworkerOnly}`);
  });

  it("requires a name and bounds the condition count", () => {
    expect(validateAutomation({ ...base, name: "" }).ok).toBe(false);
    const many = Array.from({ length: 11 }, () => ({
      field: "hour" as const,
      op: "gte" as const,
      value: 1,
    }));
    const result = validateAutomation({ ...base, conditions: { all: many } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("too_many_conditions");
  });

  it("selectable actions exclude coworker-only ones", () => {
    for (const type of selectableAutomationActions()) {
      expect(ACTION_CATALOG[type].coworkerOnly).toBeFalsy();
    }
  });

  it("explains error codes in Persian", () => {
    expect(automationErrorMessage("name_required")).toContain("نام");
    expect(automationErrorMessage("unknown_field:foo")).toContain("فیلد");
    expect(automationErrorMessage("unknown_action:foo")).toContain("عملیات");
    expect(automationErrorMessage("owner_required")).toContain("مالک");
  });
});
