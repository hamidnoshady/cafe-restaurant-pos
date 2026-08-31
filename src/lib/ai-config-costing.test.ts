import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

import { query } from "./db";
import { effectiveRate } from "./ai-config";

const mockQuery = vi.mocked(query);

beforeEach(() => {
  mockQuery.mockReset();
  const envKeys = [
    "AI_PROVIDER",
    "AI_ENABLED",
    "AI_MODEL",
    "AI_BASE_URL",
    "AI_TEMPERATURE",
    "AI_MAX_OUTPUT_TOKENS",
    "AI_INPUT_COST_RIAL_PER_MILLION",
    "AI_OUTPUT_COST_RIAL_PER_MILLION",
    "AI_REVENUE_MARGIN_PERCENT",
    "AI_MAX_TURN_RIAL",
  ];
  for (const key of envKeys) delete process.env[key];
});

describe("effectiveRate — cost plus margin, never below cost", () => {
  it("applies the revenue margin on top of the provider cost", () => {
    expect(effectiveRate(40_000, 25)).toBe(50_000);
    expect(effectiveRate(80_000, 25)).toBe(100_000);
  });

  it("zero margin sells at cost", () => {
    expect(effectiveRate(40_000, 0)).toBe(40_000);
  });

  it("rounds up so a fraction of a margin never sells below cost", () => {
    expect(effectiveRate(1, 0.5)).toBe(2);
  });

  it("a missing cost means no rate — the service stays unconfigured", () => {
    expect(effectiveRate(0, 50)).toBe(0);
  });
});
