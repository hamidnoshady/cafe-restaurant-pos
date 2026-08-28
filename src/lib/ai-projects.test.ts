import { describe, expect, it } from "vitest";
import {
  PROJECT_INSTRUCTION_CHAR_LIMIT,
  instructionWeight,
  isOverInstructionLimit,
  clampInstructions,
} from "./ai-projects-shared";
import {
  buildProjectPromptContext,
  type AiProjectNote,
} from "./ai-projects";

describe("instructionWeight", () => {
  it("counts instructions length plus all note title lengths", () => {
    expect(instructionWeight("hello", ["a", "bb", "ccc"])).toBe(5 + 1 + 2 + 3);
  });

  it("returns 0 for empty inputs", () => {
    expect(instructionWeight("", [])).toBe(0);
  });

  it("handles instructions only", () => {
    expect(instructionWeight("some instructions", [])).toBe(17);
  });

  it("handles notes only", () => {
    expect(instructionWeight("", ["note1", "note2"])).toBe(10);
  });
});

describe("isOverInstructionLimit", () => {
  it("returns false at exactly the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT)).toBe(false);
  });

  it("returns false under the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT - 1)).toBe(false);
  });

  it("returns true over the limit", () => {
    expect(isOverInstructionLimit(PROJECT_INSTRUCTION_CHAR_LIMIT + 1)).toBe(true);
  });

  it("returns false for zero", () => {
    expect(isOverInstructionLimit(0)).toBe(false);
  });
});

describe("clampInstructions", () => {
  it("returns instructions unchanged when under the limit", () => {
    const instructions = "short";
    expect(clampInstructions(instructions, [])).toBe(instructions);
  });

  it("trims instructions to fit within the budget after note titles", () => {
    const titles = ["a".repeat(1000)];
    const instructions = "b".repeat(5000);
    const result = clampInstructions(instructions, titles);
    expect(result.length).toBe(PROJECT_INSTRUCTION_CHAR_LIMIT - 1000);
  });

  it("returns empty string when note titles consume the entire budget", () => {
    const titles = ["a".repeat(PROJECT_INSTRUCTION_CHAR_LIMIT)];
    expect(clampInstructions("anything", titles)).toBe("");
  });

  it("returns empty string when note titles exceed the budget", () => {
    const titles = ["a".repeat(PROJECT_INSTRUCTION_CHAR_LIMIT + 100)];
    expect(clampInstructions("anything", titles)).toBe("");
  });
});

describe("buildProjectPromptContext", () => {
  it("includes instructions when present", () => {
    const result = buildProjectPromptContext("Be helpful", []);
    expect(result).toContain("دستور پروژه");
    expect(result).toContain("Be helpful");
  });

  it("includes note titles when present", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "Budget plan", content: "", createdBy: "u1", createdAt: "" },
      { id: "2", projectId: "p1", title: "Timeline", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext("", notes);
    expect(result).toContain("یادداشت‌های پروژه");
    expect(result).toContain("Budget plan");
    expect(result).toContain("Timeline");
  });

  it("includes both instructions and notes", () => {
    const notes: AiProjectNote[] = [
      { id: "1", projectId: "p1", title: "Note A", content: "", createdBy: "u1", createdAt: "" },
    ];
    const result = buildProjectPromptContext("Focus on sales", notes);
    expect(result).toContain("دستور پروژه");
    expect(result).toContain("Focus on sales");
    expect(result).toContain("یادداشت‌های پروژه");
    expect(result).toContain("Note A");
  });

  it("returns empty string when both are empty", () => {
    expect(buildProjectPromptContext("", [])).toBe("");
  });

  it("returns empty string when instructions are only whitespace", () => {
    expect(buildProjectPromptContext("   ", [])).toBe("");
  });
});
