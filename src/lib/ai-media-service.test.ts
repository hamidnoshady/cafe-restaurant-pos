/**
 * Provider-half tests for the media library's AI abilities (migration 0149),
 * with `fetch` stubbed — no network, no database.
 *
 * What must never regress:
 *   • label detection sends ONE vision turn (system prompt + image data URL)
 *     to /chat/completions and parses the JSON proposal;
 *   • provider failures map to the exact MediaAiError codes the route
 *     translates into Persian HTTP errors (ai_auth → 502, ai_timeout → 504,
 *     enhance_unsupported → 501 …);
 *   • enhance posts multipart to /images/edits WITHOUT a JSON content-type,
 *     accepts both b64_json and url replies, and refuses empty/oversize bytes
 *     — the caller charges the wallet only after this function returns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "./ai";
import { MediaAiError, runMediaEnhance, runMediaLabelDetection } from "./ai-media-service";

const config: AiConfig = {
  enabled: true,
  provider: "litellm",
  model: "gpt-4o-mini",
  baseUrl: "https://gw.example.com/v1",
  apiKey: "sk-test",
  temperature: 0.7,
  maxOutputTokens: 800,
};

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runMediaLabelDetection", () => {
  it("sends one vision turn and returns the parsed proposal with usage", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  category: "نوشیدنی گرم",
                  tags: ["قهوه", "اسپرسو"],
                  description: "فنجان اسپرسو روی نعلبکی",
                }),
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 60 },
        },
        { headers: { "content-type": "application/json", "x-litellm-response-cost": "0.0031" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMediaLabelDetection({
      config,
      dataUrl: PNG_DATA_URL,
      fileName: "espresso.png",
    });

    expect(result.category).toBe("نوشیدنی گرم");
    expect(result.tags).toEqual(["قهوه", "اسپرسو"]);
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 60 });
    expect(result.costUsd).toBeCloseTo(0.0031);

    // The request itself: correct URL, bearer key, image attached as image_url.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      messages: { role: string; content: unknown }[];
    };
    expect(body.model).toBe("gpt-4o-mini");
    // Labeling is extraction, not creativity — temperature is clamped low.
    expect(body.temperature).toBeLessThanOrEqual(0.2);
    const userParts = body.messages[1].content as { type: string; image_url?: { url: string } }[];
    expect(userParts.some((p) => p.type === "image_url" && p.image_url?.url === PNG_DATA_URL)).toBe(true);
  });

  it("maps 401/403 to ai_auth — the route's 502, never a silent retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(
      runMediaLabelDetection({ config, dataUrl: PNG_DATA_URL, fileName: "x.png" }),
    ).rejects.toMatchObject({ code: "ai_auth" });
  });

  it("maps an abort to ai_timeout and a socket error to ai_network", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(abortErr)));
    await expect(
      runMediaLabelDetection({ config, dataUrl: PNG_DATA_URL, fileName: "x.png" }),
    ).rejects.toMatchObject({ code: "ai_timeout" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(
      runMediaLabelDetection({ config, dataUrl: PNG_DATA_URL, fileName: "x.png" }),
    ).rejects.toMatchObject({ code: "ai_network" });
  });

  it("refuses an unusable reply rather than inventing labels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: "متأسفم، نمی‌توانم" } }] })),
    );
    await expect(
      runMediaLabelDetection({ config, dataUrl: PNG_DATA_URL, fileName: "x.png" }),
    ).rejects.toMatchObject({ code: "ai_reply_invalid" });
  });

  it("estimates tokens when the provider omits usage (billing still settles)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [
            { message: { content: JSON.stringify({ category: "دسر", tags: ["کیک"], description: "" }) } },
          ],
        }),
      ),
    );
    const result = await runMediaLabelDetection({ config, dataUrl: PNG_DATA_URL, fileName: "cake.png" });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeNull();
  });
});

describe("runMediaEnhance", () => {
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("posts multipart to /images/edits and returns decoded b64 bytes", async () => {
    const outBytes = Buffer.from("enhanced-png-bytes");
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        { data: [{ b64_json: outBytes.toString("base64") }] },
        { headers: { "content-type": "application/json", "x-litellm-response-cost": "0.04" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMediaEnhance({
      config,
      model: "gpt-image-1",
      imageBytes: pngBytes,
      mimeType: "image/png",
      fileName: "product.png",
    });

    expect(result.bytes.equals(outBytes)).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.04);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gw.example.com/v1/images/edits");
    // multipart: fetch must set its own boundary — a JSON content-type here
    // breaks every OpenAI-compatible provider.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-image-1");
    expect(String(form.get("prompt"))).toMatch(/white/i);
  });

  it("downloads the image when the provider answers with a url instead of b64", async () => {
    const outBytes = Buffer.from("enhanced-via-url");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: "https://cdn.example.com/out.png" }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array(outBytes), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runMediaEnhance({
      config,
      model: "gpt-image-1",
      imageBytes: pngBytes,
      mimeType: "image/png",
      fileName: "p.png",
    });
    expect(result.bytes.equals(outBytes)).toBe(true);
    // SSRF mitigation wrapped the URL string in a URL object
    expect(fetchMock.mock.calls[1][0].href).toBe("https://cdn.example.com/out.png");
  });

  it("maps 404/400 to enhance_unsupported — the graceful «پشتیبانی نمی‌کند» path", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no such model", { status: 404 })));
    await expect(
      runMediaEnhance({ config, model: "gpt-image-1", imageBytes: pngBytes, mimeType: "image/png", fileName: "p.png" }),
    ).rejects.toMatchObject({ code: "enhance_unsupported" });
  });

  it("refuses empty output bytes — the wallet must never be charged for nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [{ b64_json: "" }] })));
    await expect(
      runMediaEnhance({ config, model: "gpt-image-1", imageBytes: pngBytes, mimeType: "image/png", fileName: "p.png" }),
    ).rejects.toBeInstanceOf(MediaAiError);
  });

  it("refuses a reply with no data array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ created: 1 })));
    await expect(
      runMediaEnhance({ config, model: "gpt-image-1", imageBytes: pngBytes, mimeType: "image/png", fileName: "p.png" }),
    ).rejects.toMatchObject({ code: "ai_reply_invalid" });
  });
});
