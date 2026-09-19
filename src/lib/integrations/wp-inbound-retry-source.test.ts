import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/lib/integrations/wp-manager-service.ts", "utf8");

describe("WP inbound retry wiring", () => {
  it("retries existing inbox rows through the existing-row reprocessor", () => {
    expect(source).toContain("reprocessExistingIngestEvent");
    expect(source).not.toContain("applyIngestEvent(connection");
  });

  it("does not flip failed inbox rows to pending before deduplication", () => {
    const retrySection = source.slice(source.indexOf("export async function retryWpQueueRow"), source.indexOf("export async function retryAllFailedWpQueue"));
    expect(retrySection).not.toContain("SET status = 'pending', error = NULL, processed_at = NULL");
  });
});
