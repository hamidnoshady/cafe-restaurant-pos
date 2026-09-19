import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ query: vi.fn() }));

vi.mock("./ai-rag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-rag")>();
  return {
    ...actual,
    isRetrievalAvailable: vi.fn(),
  };
});

import { query } from "./db";
import { isRetrievalAvailable } from "./ai-rag";
import { getAiKnowledgeStatus } from "./ai-knowledge-service";

const mockQuery = vi.mocked(query);
const mockRetrieval = vi.mocked(isRetrievalAvailable);

beforeEach(() => {
  mockQuery.mockReset();
  mockRetrieval.mockReset();
});

describe("Phase I — AI knowledge status", () => {
  it("reports retrieval unavailable with every kind at zero and touches no table", async () => {
    mockRetrieval.mockResolvedValue(false);

    const status = await getAiKnowledgeStatus("biz-1", true);

    expect(status.retrievalAvailable).toBe(false);
    expect(status.aiConfigured).toBe(true);
    expect(status.totalChunks).toBe(0);
    expect(status.lastIndexedAt).toBeNull();
    // Every embeddable kind is still listed (a truthful empty state), all zero.
    expect(status.byKind.length).toBeGreaterThan(0);
    expect(status.byKind.every((k) => k.count === 0)).toBe(true);
    // No DB read when retrieval infra is absent.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("folds per-kind counts, totals them and finds the latest index time", async () => {
    mockRetrieval.mockResolvedValue(true);
    mockQuery.mockResolvedValue({
      rows: [
        { kind: "menu_item", count: "12", last_indexed_at: "2026-09-01T10:00:00.000Z" },
        { kind: "customer", count: "5", last_indexed_at: "2026-09-05T08:00:00.000Z" },
        { kind: "project_note", count: "3", last_indexed_at: "2026-08-20T00:00:00.000Z" },
      ],
    } as never);

    const status = await getAiKnowledgeStatus("biz-1", true);

    expect(status.retrievalAvailable).toBe(true);
    expect(status.totalChunks).toBe(20);
    expect(status.lastIndexedAt).toBe("2026-09-05T08:00:00.000Z");

    const menu = status.byKind.find((k) => k.kind === "menu_item")!;
    expect(menu.count).toBe(12);
    expect(menu.label).toBeTruthy();
    // A kind with no rows is still present, at zero.
    const help = status.byKind.find((k) => k.kind === "help")!;
    expect(help.count).toBe(0);
    expect(help.lastIndexedAt).toBeNull();
  });

  it("ignores an unknown/legacy kind returned by the table", async () => {
    mockRetrieval.mockResolvedValue(true);
    mockQuery.mockResolvedValue({
      rows: [
        { kind: "menu_item", count: "4", last_indexed_at: "2026-09-01T10:00:00.000Z" },
        { kind: "order", count: "99", last_indexed_at: "2026-09-01T10:00:00.000Z" },
      ],
    } as never);

    const status = await getAiKnowledgeStatus("biz-1", false);

    // The numbers-bearing `order` kind is never embeddable and is dropped, so
    // it never inflates the total.
    expect(status.totalChunks).toBe(4);
    expect(status.byKind.some((k) => (k.kind as string) === "order")).toBe(false);
    expect(status.aiConfigured).toBe(false);
  });
});
