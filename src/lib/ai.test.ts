import { describe, expect, it } from "vitest";
import {
  ACTION_CATALOG,
  ACTION_TYPES,
  buildSystemPrompt,
  chatCompletionsUrl,
  defaultConfig,
  isKnownAction,
  isProvider,
  PROVIDERS,
  resolveActionEndpoint,
  toolDefinitions,
  toPublicConfig,
  validateConfigInput,
} from "./ai";
import { actionTypesForCategory } from "./ai-autopilot";

describe("provider metadata", () => {
  it("knows both providers and only those", () => {
    expect(isProvider("openrouter")).toBe(true);
    expect(isProvider("arvan")).toBe(true);
    expect(isProvider("openai")).toBe(false);
    expect(isProvider(null)).toBe(false);
  });

  it("defaultConfig uses the provider's defaults and is disabled with no key", () => {
    const c = defaultConfig("arvan");
    expect(c.provider).toBe("arvan");
    expect(c.model).toBe(PROVIDERS.arvan.defaultModel);
    expect(c.baseUrl).toBe(PROVIDERS.arvan.defaultBaseUrl);
    expect(c.enabled).toBe(false);
    expect(c.apiKey).toBe("");
  });
});

describe("chatCompletionsUrl", () => {
  it("appends the path and tolerates a trailing slash", () => {
    expect(chatCompletionsUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://openrouter.ai/api/v1/")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });
});

describe("toPublicConfig", () => {
  it("never leaks the key, only a hint", () => {
    const pub = toPublicConfig({
      ...defaultConfig("openrouter"),
      apiKey: "sk-or-secret-abcd1234",
      enabled: true,
    });
    expect(pub).not.toHaveProperty("apiKey");
    expect(pub.hasKey).toBe(true);
    expect(pub.keyHint).toBe("1234");
  });

  it("reports no key when empty", () => {
    const pub = toPublicConfig(defaultConfig("openrouter"));
    expect(pub.hasKey).toBe(false);
    expect(pub.keyHint).toBeNull();
  });
});

describe("validateConfigInput", () => {
  it("accepts a well-formed config", () => {
    expect(
      validateConfigInput({
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        baseUrl: "https://openrouter.ai/api/v1",
        temperature: 0.3,
      }),
    ).toEqual([]);
  });

  it("flags bad provider, model, base url and temperature", () => {
    const errors = validateConfigInput({
      provider: "nope",
      model: "  ",
      baseUrl: "ftp://x",
      temperature: 9,
    });
    expect(errors).toContain("ai_bad_provider");
    expect(errors).toContain("ai_bad_model");
    expect(errors).toContain("ai_bad_base_url");
    expect(errors).toContain("ai_bad_temperature");
  });
});

describe("action allowlist", () => {
  it("only recognises catalog types", () => {
    expect(isKnownAction("setup.tax")).toBe(true);
    expect(isKnownAction("setup.menu.item")).toBe(true);
    expect(isKnownAction("drop.table")).toBe(false);
    expect(isKnownAction(42)).toBe(false);
  });

  it("every catalog entry maps to a real endpoint and matches its key", () => {
    for (const type of ACTION_TYPES) {
      const meta = ACTION_CATALOG[type];
      expect(meta.type).toBe(type);
      expect(["POST", "PATCH", "PUT"]).toContain(meta.method);
      expect(meta.endpoint.startsWith("/api/")).toBe(true);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.payloadHint.length).toBeGreaterThan(0);
    }
  });
});

describe("Phase 18b Wave 2 — propose_action catalogue expansion", () => {
  const wave2Types = [
    "menu.item.priceUpdate",
    "menu.item.disable",
    "order.discount.apply",
    "inventory.reorder.draftPO",
    "inventory.adjustment.propose",
    "reservation.create",
    "reservation.reschedule",
    "table.merge",
    "table.split",
    "courier.assign",
    "customer.note.add",
    "journal.manual.propose",
    "expense.categorize",
  ] as const;

  it("recognises every Wave 2 action", () => {
    for (const type of wave2Types) {
      expect(isKnownAction(type)).toBe(true);
      expect(ACTION_TYPES).toContain(type);
    }
  });

  it("the six documented schema-gap actions are deliberately absent, not just forgotten", () => {
    for (const type of [
      "delivery.eta.adjust",
      "customer.creditLimit.propose",
      "staff.shift.create",
      "staff.shift.swap.propose",
      "discount.create",
      "promo.create",
    ]) {
      expect(isKnownAction(type)).toBe(false);
    }
  });

  it("dashboard prompt's catalog dump names every Wave 2 action", () => {
    const prompt = buildSystemPrompt({ mode: "dashboard" });
    for (const type of wave2Types) {
      expect(prompt).toContain(type);
    }
  });
});

describe("resolveActionEndpoint", () => {
  it("substitutes a single placeholder from the payload", () => {
    const meta = ACTION_CATALOG["menu.item.priceUpdate"];
    expect(resolveActionEndpoint(meta, { menuItemId: "abc-123", price: 50000 })).toBe(
      "/api/menu/items/abc-123",
    );
  });

  it("URL-encodes the substituted value", () => {
    const meta = ACTION_CATALOG["order.discount.apply"];
    expect(resolveActionEndpoint(meta, { orderId: "a/b c" })).toBe("/api/orders/a%2Fb%20c");
  });

  it("returns null when a required placeholder is missing from the payload", () => {
    const meta = ACTION_CATALOG["reservation.reschedule"];
    expect(resolveActionEndpoint(meta, { reservedAt: "2026-01-01T10:00:00Z" })).toBeNull();
  });

  it("passes through endpoints with no placeholder untouched", () => {
    const meta = ACTION_CATALOG["reservation.create"];
    expect(resolveActionEndpoint(meta, {})).toBe("/api/reservations");
  });
});

describe("prompts and tools", () => {
  it("wizard prompt names the current step and lists actions", () => {
    const prompt = buildSystemPrompt({ mode: "wizard", currentStep: "tax", businessName: "کافه بهار" });
    expect(prompt).toContain("کافه بهار");
    expect(prompt).toContain("مالیات");
    expect(prompt).toContain("propose_action");
    expect(prompt).toContain("setup.tax");
  });

  it("dashboard prompt mentions reports", () => {
    const prompt = buildSystemPrompt({ mode: "dashboard" });
    expect(prompt).toContain("run_report");
  });

  it("dashboard tools expose reports + propose_action; wizard trims report list", () => {
    const dash = toolDefinitions("dashboard").map((t) => t.function.name);
    expect(dash).toContain("run_report");
    expect(dash).toContain("list_reports");
    expect(dash).toContain("propose_action");

    const wiz = toolDefinitions("wizard").map((t) => t.function.name);
    expect(wiz).toContain("propose_action");
    expect(wiz).toContain("get_setup_state");
    expect(wiz).not.toContain("run_report");
  });

  it("dashboard exposes every Phase 18b Wave 1 read tool, none of them in wizard mode", () => {
    const wave1Tools = [
      "get_menu_performance",
      "get_void_pattern",
      "get_stock_valuation",
      "get_supplier_performance",
      "get_reservation_conflicts",
      "get_table_turnover_rate",
      "get_courier_performance",
      "get_customer_profile",
      "get_at_risk_customers",
      "get_ar_aging",
      "get_ap_upcoming",
      "get_unreconciled_bank_lines",
      "get_payroll_summary",
      "get_vat_liability",
      "get_branch_comparison",
      "forecast_demand",
      "get_near_expiry_items",
      "get_staff_commission",
      "get_repurchase_candidates",
    ];
    const dash = toolDefinitions("dashboard").map((t) => t.function.name);
    const wiz = toolDefinitions("wizard").map((t) => t.function.name);
    for (const name of wave1Tools) {
      expect(dash).toContain(name);
      expect(wiz).not.toContain(name);
    }
    // every tool has a non-empty Persian description
    for (const tool of toolDefinitions("dashboard")) {
      expect(tool.function.description.length).toBeGreaterThan(0);
    }
  });

  it("dashboard prompt names every Wave 1 tool group so the model knows they exist", () => {
    const prompt = buildSystemPrompt({ mode: "dashboard" });
    expect(prompt).toContain("get_menu_performance");
    expect(prompt).toContain("get_vat_liability");
    expect(prompt).toContain("forecast_demand");
  });

  it("Phase 27 Wave 13 adds the close-out read tools to dashboard mode only", () => {
    const dash = toolDefinitions("dashboard").map((t) => t.function.name);
    const wiz = toolDefinitions("wizard").map((t) => t.function.name);
    for (const name of ["get_near_expiry_items", "get_staff_commission", "get_repurchase_candidates"]) {
      expect(dash).toContain(name);
      expect(wiz).not.toContain(name);
    }

    const prompt = buildSystemPrompt({ mode: "dashboard" });
    expect(prompt).toContain("get_near_expiry_items");
    expect(prompt).toContain("get_staff_commission");
    expect(prompt).toContain("get_repurchase_candidates");
  });
});


describe("Phase 18b Wave 3 — role-scoped agent variants", () => {
  it("keeps cashier/waiter tools read-only and out of the action catalogue", () => {
    const floor = toolDefinitions("floor").map((tool) => tool.function.name);
    expect(floor).toEqual(["get_menu_item_details", "get_bill_split_preview"]);
    expect(floor).not.toContain("propose_action");

    const prompt = buildSystemPrompt({ mode: "floor", role: "cashier" });
    expect(prompt).toContain("get_bill_split_preview");
    expect(prompt).toContain("هرگز از روی نام مواد حدس نزن");
  });

  it("keeps the platform-support realm separate and health-only", () => {
    const platform = toolDefinitions("platform").map((tool) => tool.function.name);
    expect(platform).toEqual(["get_client_update_status", "get_backup_health"]);
    expect(platform).not.toContain("propose_action");
    expect(platform).not.toContain("get_menu_performance");

    const prompt = buildSystemPrompt({ mode: "platform", role: "platform-support" });
    expect(prompt).toContain("وضعیت نسخهٔ نصب‌های مشتری");
    expect(prompt).toContain("دادهٔ عملیاتی یا شخصی");
  });
});

describe("Phase 18b Wave 4 — proactive agent isolation", () => {
  it("gives scheduled digests no tools and no action path", () => {
    expect(toolDefinitions("proactive")).toEqual([]);
    const prompt = buildSystemPrompt({ mode: "proactive", businessName: "کافه آزمون" });
    expect(prompt).toContain("هیچ ابزار");
    expect(prompt).toContain("هیچ پیشنهاد اجرایی");
    expect(prompt).toContain("هرگز پیام مشتری");
    expect(prompt).not.toContain("انواع عملیات مجاز برای propose_action");
  });
});

describe("AI Hub Wave 5 (issue #145) — receipt attachment tool", () => {
  it("only offers draft_expense_from_receipt in dashboard mode when a turn has an attachment", () => {
    const withoutAttachment = toolDefinitions("dashboard").map((t) => t.function.name);
    expect(withoutAttachment).not.toContain("draft_expense_from_receipt");

    const withAttachment = toolDefinitions("dashboard", { hasAttachment: true }).map((t) => t.function.name);
    expect(withAttachment).toContain("draft_expense_from_receipt");
    expect(withAttachment).toContain("propose_action");

    expect(toolDefinitions("wizard", { hasAttachment: true }).map((t) => t.function.name)).not.toContain(
      "draft_expense_from_receipt",
    );
    expect(toolDefinitions("floor", { hasAttachment: true }).map((t) => t.function.name)).not.toContain(
      "draft_expense_from_receipt",
    );
  });

  it("mentions the tool in the dashboard prompt only when the turn has an attachment", () => {
    const withAttachment = buildSystemPrompt({ mode: "dashboard", hasAttachment: true });
    expect(withAttachment).toContain("draft_expense_from_receipt");
    expect(withAttachment).toContain("expense.categorize");

    const withoutAttachment = buildSystemPrompt({ mode: "dashboard" });
    expect(withoutAttachment).not.toContain("draft_expense_from_receipt");
  });
});

describe("Phase 33 — the assistant's manners", () => {
  const dashboard = buildSystemPrompt({ mode: "dashboard" });

  it("forbids asking the user for an id, and points at the tool that resolves a name", () => {
    expect(dashboard).toContain("find_items");
    expect(dashboard).toContain("هرگز از کاربر شناسه");
  });

  it("forbids printing raw enum values to a Persian-speaking owner", () => {
    expect(dashboard).toContain("spoilage");
    expect(dashboard).toContain("برچسب فارسی");
  });

  it("says a disabled item is an answer, not a miss", () => {
    expect(dashboard).toContain("غیرفعال است");
  });

  it("asks for phone-shaped answers, since that is where this is read", () => {
    expect(dashboard).toContain("موبایل");
    expect(dashboard).toContain("سه ستون");
  });

  it("offers the three orientation tools in dashboard mode", () => {
    const names = toolDefinitions("dashboard").map((tool) => tool.function.name);
    expect(names).toEqual(expect.arrayContaining(["find_items", "get_waste_history", "describe_app"]));
  });

  it("keeps them out of the wizard, which is scoped to setup state", () => {
    const names = toolDefinitions("wizard").map((tool) => tool.function.name);
    expect(names).not.toContain("find_items");
  });

  it("makes find_items require only a plain-language query", () => {
    const findItems = toolDefinitions("dashboard").find((tool) => tool.function.name === "find_items");
    expect(findItems?.function.parameters).toMatchObject({ required: ["query"] });
  });
});

describe("Phase 31 — autopilot tagging of the action catalogue", () => {
  const eligible = ACTION_TYPES.filter((t) => ACTION_CATALOG[t].autopilotCategory);

  it("pins the eligible set, so tagging a new action is a deliberate change", () => {
    expect(eligible.sort()).toEqual(
      [
        "customer.note.add",
        "expense.categorize",
        "inventory.adjustment.propose",
        "inventory.reorder.draftPO",
        "journal.manual.propose",
        "menu.item.disable",
        "menu.item.priceUpdate",
        "order.discount.apply",
        // Phase 32 additions. `inventory.waste.log` is also `coworkerOnly`,
        // which is the whole distinction: eligible for an unattended write,
        // but only from a job a human wrote down — never from the model's own
        // discovery. The next test pins that half.
        "inventory.production.run",
        "inventory.waste.log",
      ].sort(),
    );
  });

  it("keeps waste out of an autopilot run's own catalogue — only a human-authored job may log it", () => {
    const coworkerOnly = ACTION_TYPES.filter((t) => ACTION_CATALOG[t].coworkerOnly);
    expect(coworkerOnly).toEqual(["inventory.waste.log"]);
    // Phase 31's reasoning — "why did this stock leave" is a fact only a person
    // in the room has — still holds for a model deciding on its own.
    expect(actionTypesForCategory("waste")).toEqual([]);
  });

  it("tags category, executor and revertible together — never half of them", () => {
    for (const type of ACTION_TYPES) {
      const meta = ACTION_CATALOG[type];
      const tagged = [meta.autopilotCategory, meta.executor, meta.revertible !== undefined].filter(Boolean).length;
      expect(tagged === 0 || tagged === 3, type).toBe(true);
    }
  });

  it("leaves the live floor actions manual-only — a 15-minute-behind tick cannot judge a room", () => {
    for (const type of [
      "reservation.create",
      "reservation.reschedule",
      "table.merge",
      "table.split",
      "courier.assign",
    ] as const) {
      expect(ACTION_CATALOG[type].autopilotCategory, type).toBeUndefined();
    }
  });

  it("keeps journal.manual.propose pointed at the DRAFT endpoint, never the approve route", () => {
    // Phase 31 Decision 1: autopilot creates the draft, a human still approves
    // it. Repointing this endpoint would collapse Phase 16's approval control.
    expect(ACTION_CATALOG["journal.manual.propose"].endpoint).toBe("/api/ledger/entries/drafts");
    expect(ACTION_CATALOG["journal.manual.propose"].endpoint).not.toContain("approve");
  });

  it("narrows propose_action's enum to the run's own category in autopilot mode", () => {
    const tools = toolDefinitions("autopilot", { actionTypes: ["menu.item.priceUpdate"] });
    expect(tools.map((t) => t.function.name)).toEqual(["propose_action"]);
    const params = tools[0].function.parameters as { properties: { type: { enum: string[] } } };
    expect(params.properties.type.enum).toEqual(["menu.item.priceUpdate"]);
  });

  it("exposes no tool at all when a category has no eligible action", () => {
    expect(toolDefinitions("autopilot", { actionTypes: [] })).toEqual([]);
  });

  it("names only the run's own actions in the autopilot prompt", () => {
    const prompt = buildSystemPrompt({
      mode: "autopilot",
      autopilotCategory: "pricing",
      allowedActionTypes: ["menu.item.priceUpdate"],
    });
    expect(prompt).toContain("menu.item.priceUpdate");
    expect(prompt).not.toContain("expense.categorize");
    expect(prompt).toContain("هیچ کانال ارسالی وجود ندارد");
  });
});
