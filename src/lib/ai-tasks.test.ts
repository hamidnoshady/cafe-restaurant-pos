import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_TASK_CHARS } from "./ai-attachment-limits";
import {
  AI_TASKS,
  CUSTOM_TASK_FRAME,
  sanitizeCustomTask,
  taskById,
  taskDirectiveFor,
  taskSuggestions,
} from "./ai-tasks";

describe("AI task catalog", () => {
  it("every id is unique and every task declares where it belongs", () => {
    const ids = AI_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of AI_TASKS) {
      expect(task.modes.length).toBeGreaterThan(0);
      expect(task.modes.every((mode) => mode === "dashboard" || mode === "floor")).toBe(true);
    }
  });

  it("exposes a lookup and starter suggestions", () => {
    expect(taskById("sales")?.label).toBe("تحلیل فروش");
    const sales = taskSuggestions("sales", "dashboard", ["fallback"]);
    expect(sales.length).toBeGreaterThan(0);
    expect(sales).not.toEqual(["fallback"]);
    expect(taskSuggestions("general", "dashboard", ["fallback"])).toEqual(["fallback"]);
  });
});

describe("sanitizeCustomTask", () => {
  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeCustomTask("  a\u0000b\r\nc\t d  ")).toBe("a b c d");
  });

  it("caps the length", () => {
    expect(sanitizeCustomTask("x".repeat(MAX_CUSTOM_TASK_CHARS + 50))).toHaveLength(
      MAX_CUSTOM_TASK_CHARS,
    );
  });
});

describe("taskDirectiveFor", () => {
  it("returns the directive for a known task in a matching mode", () => {
    const directive = taskDirectiveFor({ task: "sales", mode: "dashboard" });
    expect(directive).toBe(taskById("sales")?.directive);
    expect(directive).toContain("فروش");
  });

  it("ignores a task that does not belong to the mode", () => {
    expect(taskDirectiveFor({ task: "sales", mode: "floor" })).toBeNull();
    expect(taskDirectiveFor({ task: "split", mode: "dashboard" })).toBeNull();
    expect(taskDirectiveFor({ task: "general", mode: "wizard" })).toBeNull();
  });

  it("ignores unknown ids instead of failing", () => {
    expect(taskDirectiveFor({ task: "not-a-task", mode: "dashboard" })).toBeNull();
    expect(taskDirectiveFor({ task: 42, mode: "dashboard" })).toBeNull();
  });

  it("frames a custom task and lets it win over a preset id", () => {
    const directive = taskDirectiveFor({
      task: "sales",
      customTask: "  فقط دربارهٔ چای و قهوه جواب بده \u0000",
      mode: "dashboard",
    });
    expect(directive).toBe(`${CUSTOM_TASK_FRAME}فقط دربارهٔ چای و قهوه جواب بده`);
    expect(directive).not.toContain("تمرکز این گفتگو تحلیل فروش");
  });

  it("falls back to the preset id when the custom text is empty or not a string", () => {
    expect(taskDirectiveFor({ task: "sales", customTask: "   ", mode: "dashboard" })).toContain(
      "تحلیل فروش",
    );
    expect(
      taskDirectiveFor({ task: "sales", customTask: { evil: true }, mode: "dashboard" }),
    ).toContain("تحلیل فروش");
  });
});
