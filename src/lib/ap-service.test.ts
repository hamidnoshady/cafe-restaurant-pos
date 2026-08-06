import { describe, expect, it, vi } from "vitest";
import { payBill } from "./ap-service";
import * as db from "./db";

// Mock the db module
vi.mock("./db", () => {
  return {
    getPool: vi.fn(),
  };
});

describe("payBill", () => {
  it("rolls back the transaction if an error occurs", async () => {
    // Setup a mock client
    const mockQuery = vi.fn().mockImplementation(async (queryStr: string) => {
      if (queryStr !== "BEGIN" && queryStr !== "ROLLBACK") {
        throw new Error("Simulated database error");
      }
      return { rows: [] };
    });

    const mockRelease = vi.fn();

    const mockClient = {
      query: mockQuery,
      release: mockRelease,
    };

    // Make getPool().connect() return our mock client
    (db.getPool as any).mockReturnValue({
      connect: vi.fn().mockResolvedValue(mockClient),
    });

    // Execute payBill and expect it to throw our simulated error
    await expect(
      payBill({
        businessId: "biz-1",
        locationId: "loc-1",
        supplierId: "sup-1",
        method: "cash",
        amount: 1000,
        createdBy: "user-1",
      })
    ).rejects.toThrow("Simulated database error");

    // Verify ROLLBACK was executed
    expect(mockQuery).toHaveBeenCalledWith("ROLLBACK");

    // Verify release was called
    expect(mockRelease).toHaveBeenCalled();
  });
});
