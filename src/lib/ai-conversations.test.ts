import { describe, expect, it } from "vitest";
import { deriveConversationTitle } from "./ai-conversations";

describe("deriveConversationTitle", () => {
  it("uses a fallback title for empty or whitespace-only content", () => {
    expect(deriveConversationTitle("")).toBe("مکالمه جدید");
    expect(deriveConversationTitle("   \n\t  ")).toBe("مکالمه جدید");
  });

  it("collapses internal whitespace and trims", () => {
    expect(deriveConversationTitle("  فروش   امروز \n چقدر بود؟  ")).toBe("فروش امروز چقدر بود؟");
  });

  it("returns short content unchanged", () => {
    expect(deriveConversationTitle("سلام")).toBe("سلام");
  });

  it("truncates long content to 60 characters with an ellipsis", () => {
    const long = "الف".repeat(40);
    const title = deriveConversationTitle(long);
    expect(title.length).toBe(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title.slice(0, 60)).toBe(long.slice(0, 60));
  });
});
