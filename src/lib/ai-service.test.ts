import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./ai";
import { runAgentTurn } from "./ai-service";

const config = {
  ...defaultConfig("litellm"),
  enabled: true,
  apiKey: "test-key",
  baseUrl: "https://provider.example/v1",
};

function providerReply(message: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function streamingProviderReply(events: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Phase 18b Wave 3 agent isolation", () => {
  it("treats a crafted propose_action from the floor agent as an unknown read tool", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            {
              id: "crafted-action",
              type: "function",
              function: {
                name: "propose_action",
                arguments: JSON.stringify({
                  type: "order.discount.apply",
                  title: "نباید اجرا شود",
                  summary: "نباید اجرا شود",
                  payload: { orderId: "order-1" },
                }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(providerReply({ content: "فقط راهنمایی می‌کنم." }));
    vi.stubGlobal("fetch", fetchMock);
    const readTool = vi.fn(async () => ({ ok: true, data: { shouldNotRun: true } }));

    const reply = await runAgentTurn({
      config,
      mode: "floor",
      promptContext: { mode: "floor", role: "cashier" },
      messages: [{ role: "user", content: "برای این سفارش تخفیف بزن" }],
      executeReadTool: readTool,
    });

    expect(reply.proposedAction).toBeNull();
    expect(readTool).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstPayload.tools.map((tool: { function: { name: string } }) => tool.function.name)).not.toContain(
      "propose_action",
    );
  });

  it("runs only the platform health tool exposed by platform mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            {
              id: "health",
              type: "function",
              function: { name: "get_client_update_status", arguments: "{}" },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(providerReply({ content: "همه‌چیز بررسی شد." }));
    vi.stubGlobal("fetch", fetchMock);
    const readTool = vi.fn(async () => ({ ok: true, data: { connectedClientCount: 1 } }));

    const reply = await runAgentTurn({
      config,
      mode: "platform",
      promptContext: { mode: "platform", role: "platform-support" },
      messages: [{ role: "user", content: "نسخه‌ها را بررسی کن" }],
      executeReadTool: readTool,
    });

    expect(reply.proposedAction).toBeNull();
    expect(readTool).toHaveBeenCalledWith("get_client_update_status", {});
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstPayload.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      "get_client_update_status",
      "get_backup_health",
    ]);
  });
});

describe("Phase 18b Wave 4 proactive isolation", () => {
  it("sends scheduled digest facts without exposing tools or an action channel", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "خلاصهٔ روزانه آماده است." }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "proactive",
      promptContext: { mode: "proactive", businessName: "کافه آزمون" },
      messages: [{ role: "user", content: "داده‌های زمان‌بندی‌شده: {}" }],
    });

    expect(reply.proposedAction).toBeNull();
    expect(reply.content).toBe("خلاصهٔ روزانه آماده است.");
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
  });
});


describe("AI Hub Wave 5 (issue #145) — receipt attachment tool", () => {
  it("runs the isolated extraction call (no tools, multimodal content) and feeds fields back for propose_action", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "draft_expense_from_receipt", arguments: "{}" } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        providerReply({
          content: JSON.stringify({
            vendor: "سوپرمارکت",
            amount: 200000,
            memo: "خرید ملزومات",
            suggestedAccountCode: "5500",
          }),
        }),
      )
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            {
              id: "t2",
              type: "function",
              function: {
                name: "propose_action",
                arguments: JSON.stringify({
                  type: "expense.categorize",
                  title: "ثبت هزینه",
                  summary: "خرید ملزومات مصرفی",
                  payload: { accountId: "acc-1", paymentAccountId: "acc-2", amount: 200000, memo: "خرید ملزومات" },
                }),
              },
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const readTool = vi.fn(async () => ({ ok: true, data: {} }));

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      businessId: "biz-1",
      promptContext: { mode: "dashboard", role: "owner" },
      messages: [{ role: "user", content: "این رسید را دسته‌بندی کن" }],
      attachment: { dataUrl: "data:image/png;base64,AAAA" },
      executeReadTool: readTool,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(readTool).not.toHaveBeenCalled();
    expect(reply.proposedAction?.type).toBe("expense.categorize");

    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstPayload.tools.map((t: { function: { name: string } }) => t.function.name)).toContain(
      "draft_expense_from_receipt",
    );

    const extractionPayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(extractionPayload.tools).toBeUndefined();
    expect(extractionPayload.messages[1].content[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("refuses the tool as a normal tool result when no attachment is present on the turn", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "draft_expense_from_receipt", arguments: "{}" } },
          ],
        }),
      )
      .mockResolvedValueOnce(providerReply({ content: "بدون تصویر پیوست نمی‌توانم این کار را انجام دهم." }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      businessId: "biz-1",
      promptContext: { mode: "dashboard", role: "owner" },
      messages: [{ role: "user", content: "این رسید را دسته‌بندی کن" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reply.proposedAction).toBeNull();
    const firstPayload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstPayload.tools.map((t: { function: { name: string } }) => t.function.name)).not.toContain(
      "draft_expense_from_receipt",
    );
  });
});

describe("AI Hub Wave 5 (issue #145) — allow-action toggle", () => {
  it("drops propose_action from the tool list without touching read tools", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "فقط راهنمایی کردم." }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      businessId: "biz-1",
      promptContext: { mode: "dashboard", role: "owner" },
      messages: [{ role: "user", content: "قیمت این آیتم چقدر است؟ فعلاً چیزی تغییر نده" }],
      allowActions: false,
    });

    expect(reply.proposedAction).toBeNull();
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const toolNames = payload.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).not.toContain("propose_action");
    expect(toolNames).toContain("run_report");
  });

  it("treats a crafted propose_action call as an unknown tool when this turn disallows actions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerReply({
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: {
                name: "propose_action",
                arguments: JSON.stringify({
                  type: "menu.item.disable",
                  title: "نباید اجرا شود",
                  summary: "نباید اجرا شود",
                  payload: { menuItemId: "item-1", isActive: false },
                }),
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(providerReply({ content: "این پیام اجازهٔ پیشنهاد ندارد." }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      businessId: "biz-1",
      promptContext: { mode: "dashboard", role: "owner" },
      messages: [{ role: "user", content: "این آیتم را غیرفعال کن" }],
      allowActions: false,
    });

    expect(reply.proposedAction).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Phase 18b Wave 5 streaming", () => {
  it("forwards provider text deltas while preserving the settled final reply", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      streamingProviderReply([
        'data: {"choices":[{"delta":{"content":"سلام "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"دوست من"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":14,"completion_tokens":3}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const deltas: string[] = [];

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      promptContext: { mode: "dashboard", role: "manager" },
      messages: [{ role: "user", content: "سلام" }],
      stream: { onDelta: (content) => deltas.push(content) },
    });

    expect(deltas.join("")).toBe("سلام دوست من");
    expect(reply).toMatchObject({
      content: "سلام دوست من",
      proposedAction: null,
      usage: { inputTokens: 14, outputTokens: 3 },
    });
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
  });
});

// ---------------------------------------------------------------------------
// Phase 38b — gateway-priced turns and prompt-bound surfaces
// ---------------------------------------------------------------------------

function gatewayReply(message: Record<string, unknown>, costUsd: string) {
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "x-litellm-response-cost": costUsd },
    },
  );
}

describe("Phase 38b gateway cost capture", () => {
  it("sums the proxy's per-response cost across tool rounds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        gatewayReply(
          {
            content: null,
            tool_calls: [
              {
                id: "read-1",
                type: "function",
                function: { name: "get_sales_summary", arguments: "{}" },
              },
            ],
          },
          "0.001",
        ),
      )
      .mockResolvedValueOnce(gatewayReply({ content: "خلاصه آماده است." }, "0.002"));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      promptContext: { mode: "dashboard" },
      messages: [{ role: "user", content: "فروش امروز چطور بود؟" }],
      executeReadTool: vi.fn(async () => ({ ok: true, data: { total: 1 } })),
    });

    expect(reply.costUsd).toBeCloseTo(0.003, 10);
  });

  it("a direct vendor that sends no cost header reports null, not zero", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "پاسخ ساده." }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await runAgentTurn({
      config,
      mode: "dashboard",
      promptContext: { mode: "dashboard" },
      messages: [{ role: "user", content: "سلام" }],
    });

    expect(reply.costUsd).toBeNull();
  });

  it("the gateway config the runtime builds is what the request carries", async () => {
    // A bound surface sends prompt_id + prompt_variables and NO system message;
    // the system prompt travels as a variable so the template keeps the rules.
    const gatewayConfig = {
      ...config,
      gateway: {
        authKey: "sk-virtual",
        body: { fallbacks: ["pos-cheap"] },
        promptId: "pos-dashboard",
      },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "پاسخ با پرامپت دروازه." }));
    vi.stubGlobal("fetch", fetchMock);

    await runAgentTurn({
      config: gatewayConfig,
      mode: "dashboard",
      promptContext: { mode: "dashboard", businessName: "کافه آزمون", userName: "مدیر" },
      systemPrompt: "نظم سیستمی",
      messages: [{ role: "user", content: "سلام" }],
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.prompt_id).toBe("pos-dashboard");
    expect(payload.prompt_variables).toEqual({
      system_context: "نظم سیستمی",
      business_name: "کافه آزمون",
      user_name: "مدیر",
      mode: "dashboard",
    });
    expect(payload.fallbacks).toEqual(["pos-cheap"]);
    expect(payload.messages.every((message: { role: string }) => message.role !== "system")).toBe(true);
  });

  it("an unbound surface keeps its system message and no prompt fields", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "پاسخ معمولی." }));
    vi.stubGlobal("fetch", fetchMock);

    await runAgentTurn({
      config,
      mode: "dashboard",
      promptContext: { mode: "dashboard" },
      systemPrompt: "نظم سیستمی",
      messages: [{ role: "user", content: "سلام" }],
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(payload.prompt_id).toBeUndefined();
    expect(payload.prompt_variables).toBeUndefined();
    expect(payload.messages[0]).toEqual({ role: "system", content: "نظم سیستمی" });
  });

  it("MCP servers declared by the runtime reach the tools array", async () => {
    const mcpConfig = {
      ...config,
      gateway: {
        body: {
          tools: [
            {
              type: "mcp",
              server_url: "litellm_proxy/pos_mcp/mcp",
              server_label: "pos_mcp",
              require_approval: "never",
            },
          ],
        },
      },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(providerReply({ content: "با ابزارها پاسخ دادم." }));
    vi.stubGlobal("fetch", fetchMock);

    await runAgentTurn({
      config: mcpConfig,
      mode: "dashboard",
      promptContext: { mode: "dashboard" },
      messages: [{ role: "user", content: "سلام" }],
    });

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const tools = payload.tools as { type: string }[];
    // The proxy's MCP entries lead; the agent's own function tools follow in
    // the same array — one `tools` field, distinguished by `type`.
    expect(tools[0]).toEqual(mcpConfig.gateway.body.tools[0]);
    expect(tools.slice(1).every((tool) => tool.type === "function")).toBe(true);
    expect(tools.length).toBeGreaterThan(1);
  });
});
