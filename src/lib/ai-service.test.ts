import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./ai";
import { runAgentTurn } from "./ai-service";

const config = {
  ...defaultConfig("openrouter"),
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
