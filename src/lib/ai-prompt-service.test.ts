import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn(), getPool: vi.fn() }));

import { query } from "./db";
import { buildSystemPrompt } from "./ai";
import {
  BUSINESS_PROMPT_SURFACES,
  MAX_BUSINESS_INSTRUCTIONS_CHARS,
  PLATFORM_PROMPT_SURFACES,
  isBusinessPromptSurface,
  loadBusinessInstructions,
  loadPlatformSurfacePrompt,
  resetPromptCaches,
  resolveSystemPrompt,
  saveBusinessOverride,
  deleteBusinessOverride,
} from "./ai-prompt-service";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
  resetPromptCaches();
});

describe("the two layers' surface sets", () => {
  it("the platform may author every surface; the business only its own three", () => {
    expect(PLATFORM_PROMPT_SURFACES).toContain("proactive");
    expect(PLATFORM_PROMPT_SURFACES).toContain("autopilot");
    expect(PLATFORM_PROMPT_SURFACES).toContain("platform");
    expect([...BUSINESS_PROMPT_SURFACES].sort()).toEqual(["dashboard", "floor", "wizard"]);
    expect(isBusinessPromptSurface("autopilot")).toBe(false);
    expect(isBusinessPromptSurface("dashboard")).toBe(true);
  });
});

describe("loadPlatformSurfacePrompt", () => {
  it("returns the active platform row for the surface", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ text: "پرامپت جدید مدیر پلتفرم" }] } as never);
    await expect(loadPlatformSurfacePrompt("dashboard")).resolves.toBe("پرامپت جدید مدیر پلتفرم");
    expect(mockQuery.mock.calls[0][0]).toContain("fragment_key = $1");
  });

  it("is null when no active row exists — the code default applies", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await expect(loadPlatformSurfacePrompt("floor")).resolves.toBeNull();
  });

  it("degrades to null rather than throwing", async () => {
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(loadPlatformSurfacePrompt("wizard")).resolves.toBeNull();
  });
});

describe("loadBusinessInstructions", () => {
  it("returns the business's active instruction block", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ instructions: "ما کافه هستیم" }] } as never);
    await expect(loadBusinessInstructions("b1", "dashboard")).resolves.toBe("ما کافه هستیم");
  });

  it("is null on a read failure — a layer that cannot be read is not applied", async () => {
    mockQuery.mockRejectedValueOnce(new Error("boom"));
    await expect(loadBusinessInstructions("b1", "floor")).resolves.toBeNull();
  });
});

describe("resolveSystemPrompt", () => {
  const ctx = { mode: "dashboard" as const, businessName: "کافه نمونه" };

  it("uses the platform override when one is active", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ text: "پرامپت مدیر پلتفرم" }] } as never);
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // business layer
    const prompt = await resolveSystemPrompt({ mode: "dashboard", ctx, businessId: "b1" });
    expect(prompt).toBe("پرامپت مدیر پلتفرم");
  });

  it("falls back to the code default when neither layer has a row", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never);
    const prompt = await resolveSystemPrompt({ mode: "dashboard", ctx, businessId: "b1" });
    expect(prompt).toBe(buildSystemPrompt(ctx));
  });

  it("appends the business's instructions under their own heading, after the platform prompt", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // platform layer
    mockQuery.mockResolvedValueOnce({ rows: [{ instructions: "همیشه کوتاه جواب بده" }] } as never);
    const prompt = await resolveSystemPrompt({ mode: "dashboard", ctx, businessId: "b1" });
    expect(prompt).toContain(buildSystemPrompt(ctx));
    expect(prompt.indexOf(buildSystemPrompt(ctx))).toBeLessThan(prompt.indexOf("همیشه کوتاه جواب بده"));
    expect(prompt).toContain("کسب‌وکار");
  });

  it("never asks for the business layer on a platform-only surface", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never); // platform layer only
    await resolveSystemPrompt({ mode: "autopilot", ctx: { mode: "autopilot" }, businessId: "b1" });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("returns the plain code default when every read fails", async () => {
    mockQuery.mockRejectedValue(new Error("boom"));
    const prompt = await resolveSystemPrompt({ mode: "floor", ctx: { mode: "floor" }, businessId: "b1" });
    expect(prompt).toBe(buildSystemPrompt({ mode: "floor" }));
  });
});

describe("business override writes", () => {
  it("save deactivates the previous row before inserting the new one", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never);
    await saveBusinessOverride({
      businessId: "b1",
      surface: "dashboard",
      instructions: "  متن جدید  ",
      updatedBy: "مدیر",
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain("SET is_active = false");
    expect(mockQuery.mock.calls[1][0]).toContain("INSERT INTO ai_prompt_overrides");
    const insertParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(insertParams).toContain("متن جدید");
  });

  it("rejects empty and over-long instructions with a named reason", async () => {
    await expect(
      saveBusinessOverride({ businessId: "b1", surface: "floor", instructions: "   ", updatedBy: "x" }),
    ).rejects.toThrow("empty_instructions");
    await expect(
      saveBusinessOverride({
        businessId: "b1",
        surface: "floor",
        instructions: "x".repeat(MAX_BUSINESS_INSTRUCTIONS_CHARS + 1),
        updatedBy: "x",
      }),
    ).rejects.toThrow("too_long");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("delete only touches the business's own surface", async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never);
    await deleteBusinessOverride("b1", "wizard");
    expect(mockQuery.mock.calls[0][1]).toEqual(["b1", "wizard"]);
  });
});
