import { describe, it, expect, vi, beforeEach } from "vitest";
import { closeFiscalYear } from "./closing-service";
import * as db from "./db";
import { PoolClient } from "pg";

vi.mock("./db", () => ({
  getPool: vi.fn(),
}));

describe("closing-service", () => {
  describe("closeFiscalYear", () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        query: vi.fn(),
        release: vi.fn(),
      };
      vi.mocked(db.getPool).mockReturnValue({
        connect: vi.fn().mockResolvedValue(mockClient),
      } as any);
    });

    it("rolls back transaction on error", async () => {
      // Make the very first query (BEGIN) fail to trigger the catch block.
      // Or we can let BEGIN pass and make the SELECT fail.
      mockClient.query.mockImplementation((queryText: string) => {
        if (queryText === "BEGIN") return Promise.resolve();
        return Promise.reject(new Error("DB error"));
      });

      await expect(
        closeFiscalYear(
          "00000000-0000-4000-8000-000000000001",
          "00000000-0000-4000-8000-000000000002",
          "00000000-0000-4000-8000-000000000003",
        ),
      ).rejects.toThrow("DB error");

      expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mockClient.release).toHaveBeenCalled();
    });
  });
});
