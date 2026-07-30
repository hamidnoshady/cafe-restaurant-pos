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
});
