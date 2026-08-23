import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutopilotCategories } from "./ai-autopilot-service";
import type { AutopilotCategory } from "./ai-autopilot";

describe("runAutopilotCategories", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs every enabled category in order", async () => {
    const seen: AutopilotCategory[] = [];
    const result = await runAutopilotCategories(["inventory", "pricing", "customer"], async (category) => {
      seen.push(category);
    });
    expect(seen).toEqual(["inventory", "pricing", "customer"]);
    expect(result).toEqual({ completed: 3, failed: 0 });
  });

  it("continues past a category that throws, so one failure cannot silence the rest", async () => {
    const seen: AutopilotCategory[] = [];
    const result = await runAutopilotCategories(["inventory", "pricing", "money", "customer"], async (category) => {
      seen.push(category);
      if (category === "pricing") throw new Error("provider exploded");
    });
    expect(seen).toEqual(["inventory", "pricing", "money", "customer"]);
    expect(result).toEqual({ completed: 3, failed: 1 });
  });

  it("does nothing when no category is enabled", async () => {
    const runOne = vi.fn();
    expect(await runAutopilotCategories([], runOne)).toEqual({ completed: 0, failed: 0 });
    expect(runOne).not.toHaveBeenCalled();
  });
});
