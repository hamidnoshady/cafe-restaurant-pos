import { describe, expect, it } from "vitest";
import {
  agentTurnScope,
  customAgentErrorMessage,
  selectableAgentActions,
  selectableAgentTools,
  validateCustomAgent,
  type CustomAgent,
} from "./ai-custom-agents";
import { ACTION_CATALOG, buildSystemPrompt, toolDefinitions } from "./ai";

describe("Phase D — custom agent validation", () => {
  it("accepts a well-formed agent and normalizes its allowlists", () => {
    const result = validateCustomAgent({
      name: "  دستیار انبار  ",
      instructions: "فقط دربارهٔ موجودی صحبت کن.",
      toolAllowlist: ["find_items", "find_items", "get_stock_valuation"],
      actionAllowlist: ["inventory.reorder.draftPO"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("دستیار انبار");
    // de-duplicated
    expect(result.value.toolAllowlist).toEqual(["find_items", "get_stock_valuation"]);
    expect(result.value.actionAllowlist).toEqual(["inventory.reorder.draftPO"]);
    expect(result.value.enabled).toBe(true);
  });

  it("requires a name and bounds its length", () => {
    expect(validateCustomAgent({ name: "" })).toMatchObject({ ok: false });
    const long = validateCustomAgent({ name: "x".repeat(81) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.errors).toContain("name_too_long");
  });

  it("rejects an unknown tool rather than silently dropping it", () => {
    const result = validateCustomAgent({
      name: "x",
      toolAllowlist: ["find_items", "definitely_not_a_tool"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("unknown_tool:definitely_not_a_tool");
  });

  it("rejects an unknown action and every coworker-only action", () => {
    const bad = validateCustomAgent({ name: "x", actionAllowlist: ["not.an.action"] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain("unknown_action:not.an.action");

    // A coworker-only action is a real catalogue key but must never be
    // allowlistable on an agent — only a pre-authored coworker job may name it.
    const coworkerOnly = Object.keys(ACTION_CATALOG).find(
      (type) => ACTION_CATALOG[type as keyof typeof ACTION_CATALOG].coworkerOnly,
    )!;
    const result = validateCustomAgent({ name: "x", actionAllowlist: [coworkerOnly] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain(`unknown_action:${coworkerOnly}`);
  });

  it("allows an empty action allowlist — a read-only agent", () => {
    const result = validateCustomAgent({
      name: "خواننده",
      toolAllowlist: ["get_ar_aging"],
      actionAllowlist: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.actionAllowlist).toEqual([]);
  });

  it("selectable tools are the dashboard read surface without propose_action", () => {
    const tools = selectableAgentTools();
    expect(tools).toContain("find_items");
    expect(tools).toContain("get_ar_aging");
    expect(tools).not.toContain("propose_action");
  });

  it("selectable actions exclude coworker-only ones", () => {
    const actions = selectableAgentActions();
    for (const type of actions) {
      expect(ACTION_CATALOG[type].coworkerOnly).toBeFalsy();
    }
    expect(actions).toContain("inventory.reorder.draftPO");
  });

  it("explains error codes in Persian", () => {
    expect(customAgentErrorMessage("name_required")).toContain("نام");
    expect(customAgentErrorMessage("unknown_tool:foo")).toContain("ابزار");
    expect(customAgentErrorMessage("unknown_action:foo")).toContain("عملیات");
    expect(customAgentErrorMessage("name_taken")).toContain("نام");
  });
});

describe("Phase D — agent scoping actually narrows the turn", () => {
  const agent: CustomAgent = {
    id: "agent-1",
    businessId: "biz-1",
    name: "دستیار انبار",
    instructions: "فقط دربارهٔ موجودی و خرید صحبت کن.",
    toolAllowlist: ["find_items", "get_stock_valuation"],
    actionAllowlist: ["inventory.reorder.draftPO"],
    enabled: true,
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("toolDefinitions keeps only the allowlisted reads plus the scoped propose tool", () => {
    const scope = agentTurnScope(agent);
    const tools = toolDefinitions("dashboard", {
      toolAllowlist: scope.toolAllowlist,
      actionTypes: scope.actionTypes,
    });
    const names = tools.map((t) => t.function.name);
    // Phase E — request_input rides every dashboard turn, scoped agents
    // included: asking a typed question opens no write path.
    expect(names.sort()).toEqual(
      ["find_items", "get_stock_valuation", "propose_action", "request_input"].sort(),
    );
    // and no other dashboard read leaked through
    expect(names).not.toContain("get_vat_liability");

    const proposeTool = tools.find((t) => t.function.name === "propose_action")!;
    const params = proposeTool.function.parameters as { properties: { type: { enum: string[] } } };
    expect(params.properties.type.enum).toEqual(["inventory.reorder.draftPO"]);
  });

  it("a read-only agent gets no propose_action tool at all", () => {
    const readerScope = agentTurnScope({ ...agent, actionAllowlist: [] });
    const tools = toolDefinitions("dashboard", {
      toolAllowlist: readerScope.toolAllowlist,
      actionTypes: readerScope.actionTypes,
    });
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain("propose_action");
    // Phase E — but it may still ASK the user a typed question: request_input
    // is read-shaped and never a write path.
    expect(names).toContain("request_input");
  });

  it("the prompt appends the agent's instructions and scopes the catalogue dump", () => {
    const scope = agentTurnScope(agent);
    const prompt = buildSystemPrompt({
      mode: "dashboard",
      agent: { name: scope.name, instructions: scope.instructions, actionTypes: scope.actionTypes },
    });
    // grounding still there
    expect(prompt).toContain("دستیار هوشمند");
    // agent identity + instructions
    expect(prompt).toContain("دستیار انبار");
    expect(prompt).toContain("فقط دربارهٔ موجودی و خرید صحبت کن.");
    // The authoritative catalogue dump (format "- <action>: <label>") is scoped
    // to the one allowed action; no other action's payload schema is dumped.
    expect(prompt).toContain("- inventory.reorder.draftPO:");
    expect(prompt).not.toContain("- ar.receipt.record:");
    expect(prompt).not.toContain("- menu.item.priceUpdate:");
  });

  it("a read-only agent's prompt says it can propose nothing", () => {
    const prompt = buildSystemPrompt({
      mode: "dashboard",
      agent: { name: "خواننده", instructions: "", actionTypes: [] },
    });
    expect(prompt).toContain("اجازهٔ هیچ عملیات اجرایی");
  });

  it("an ordinary dashboard turn (no agent) is unchanged — full surface", () => {
    const tools = toolDefinitions("dashboard").map((t) => t.function.name);
    expect(tools).toContain("propose_action");
    expect(tools).toContain("get_vat_liability");
    const prompt = buildSystemPrompt({ mode: "dashboard" });
    expect(prompt).not.toContain("تو به‌عنوان ایجنت");
  });
});
