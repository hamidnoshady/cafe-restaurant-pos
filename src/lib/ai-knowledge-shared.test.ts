import { describe, expect, it } from "vitest";
import { EMBEDDABLE_KINDS } from "./ai-rag";
import {
  AI_KNOWLEDGE_KIND_HINTS,
  AI_KNOWLEDGE_KIND_LABELS,
  knowledgeKind,
  knowledgeKindLabel,
} from "./ai-knowledge-shared";

describe("Phase I — AI knowledge shared core", () => {
  it("labels and hints every embeddable kind", () => {
    for (const kind of EMBEDDABLE_KINDS) {
      const label = AI_KNOWLEDGE_KIND_LABELS[kind];
      const hint = AI_KNOWLEDGE_KIND_HINTS[kind];
      expect(label, `label for ${kind}`).toBeTruthy();
      expect(hint, `hint for ${kind}`).toBeTruthy();
      // A label is a human name, never the raw key echoed back.
      expect(label).not.toBe(kind);
    }
  });

  it("resolves a known kind and rejects an unknown one", () => {
    expect(knowledgeKind("menu_item")).toBe("menu_item");
    expect(knowledgeKind("customer")).toBe("customer");
    // Numbers-bearing kinds are never embeddable and must not resolve.
    expect(knowledgeKind("order")).toBeNull();
    expect(knowledgeKind("payment")).toBeNull();
    expect(knowledgeKind("some_future_kind")).toBeNull();
    expect(knowledgeKind(null)).toBeNull();
    expect(knowledgeKind(undefined)).toBeNull();
  });

  it("labels a known kind and falls back to the raw name for an unknown one", () => {
    expect(knowledgeKindLabel("project_note")).toBe(
      AI_KNOWLEDGE_KIND_LABELS.project_note,
    );
    expect(knowledgeKindLabel("mystery")).toBe("mystery");
    expect(knowledgeKindLabel(null)).toBe("");
  });
});
