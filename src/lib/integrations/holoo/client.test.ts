import { describe, expect, it } from "vitest";
import { createHolooSqlClient, createHolooWebServiceClient, holooWebServiceUrl } from "./client";

describe("holooWebServiceUrl", () => {
  it("joins base URL and path once", () => {
    expect(holooWebServiceUrl("http://h:8080/TncHoloo/api/", "/Login")).toBe("http://h:8080/TncHoloo/api/Login");
  });
});

describe("createHolooWebServiceClient", () => {
  it("logs in once and posts sale, receipt and purchase documents with the token", async () => {
    const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } | undefined }> = [];
    const client = createHolooWebServiceClient(
      { baseUrl: "http://holoo/TncHoloo/api", database: "db", user: "u", password: "p" },
      async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith("/Login")) return { ok: true, status: 200, json: async () => ({ token: "tok" }) };
        return { ok: true, status: 200, json: async () => ({ documentNumber: `no-${url.split("/").pop()}` }) };
      },
    );

    await expect(client.createSaleInvoice({ sourceId: "s1", totalRial: "100" })).resolves.toBe("no-SellInvoice");
    await expect(client.createReceiptPayment({ sourceId: "r1", totalRial: "50" })).resolves.toBe("no-ReceivePay");
    await expect(client.createPurchaseInvoice({ sourceId: "p1", totalRial: "70" })).resolves.toBe("no-BuyInvoice");

    expect(calls.map((call) => call.url)).toEqual([
      "http://holoo/TncHoloo/api/Login",
      "http://holoo/TncHoloo/api/SellInvoice",
      "http://holoo/TncHoloo/api/ReceivePay",
      "http://holoo/TncHoloo/api/BuyInvoice",
    ]);
    expect(calls.slice(1).every((call) => call.init?.headers?.Authorization === "Bearer tok")).toBe(true);
    expect(calls.slice(1).map((call) => call.init?.headers?.["X-Idempotency-Key"])).toEqual(["s1", "r1", "p1"]);
  });
});

describe("createHolooSqlClient", () => {
  it("delegates transactional execution to the driver", async () => {
    const executed: readonly string[][] = [];
    const batches: string[][] = [];
    const client = createHolooSqlClient({
      query: async () => [],
      executeTransaction: async (statements) => {
        batches.push([...statements]);
      },
      close: async () => undefined,
    });
    await client.executeTransaction(["INSERT 1", "INSERT 2"]);
    expect(batches).toEqual([["INSERT 1", "INSERT 2"]]);
    expect(executed).toEqual([]);
  });
});
