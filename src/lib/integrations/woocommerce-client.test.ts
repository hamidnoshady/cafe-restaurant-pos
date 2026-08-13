import { describe, expect, it, vi } from "vitest";
import { createWooCommerceClient, wooApiUrl, wooAuthHeader, WooCommerceError } from "./woocommerce-client";

const credentials = {
  baseUrl: "https://shop.example.com",
  consumerKey: "ck_123",
  consumerSecret: "cs_456",
};

describe("wooAuthHeader", () => {
  it("is Basic base64(consumerKey:consumerSecret)", () => {
    expect(wooAuthHeader(credentials)).toBe(`Basic ${Buffer.from("ck_123:cs_456").toString("base64")}`);
  });
});

describe("wooApiUrl", () => {
  it("builds a v3 endpoint without a query", () => {
    expect(wooApiUrl("https://shop.example.com", "products")).toBe(
      "https://shop.example.com/wp-json/wc/v3/products",
    );
  });

  it("strips trailing slashes from the base and leading slashes from the path", () => {
    expect(wooApiUrl("https://shop.example.com/", "/products/42")).toBe(
      "https://shop.example.com/wp-json/wc/v3/products/42",
    );
  });

  it("serializes a query, dropping null/undefined", () => {
    expect(wooApiUrl("https://shop.example.com", "orders", { after: "2026-01-01", per_page: 100 })).toBe(
      "https://shop.example.com/wp-json/wc/v3/orders?after=2026-01-01&per_page=100",
    );
  });
});

describe("createWooCommerceClient", () => {
  it("sends credentials as a Basic auth header and JSON body", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 1 }) });
    const client = createWooCommerceClient(credentials, fetch);
    await client.updateProduct(1, { regular_price: "15000" });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products/1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: wooAuthHeader(credentials),
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ regular_price: "15000" }),
      }),
    );
  });

  it("lists products via GET", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] });
    const client = createWooCommerceClient(credentials, fetch);
    await client.listProducts({ per_page: 5 });
    expect(fetch).toHaveBeenCalledWith(
      "https://shop.example.com/wp-json/wc/v3/products?per_page=5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("wraps a non-2xx response in WooCommerceError with the server's message", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ code: "rest_forbidden", message: "Invalid signature" }),
    });
    const client = createWooCommerceClient(credentials, fetch);
    await expect(client.getProduct(1)).rejects.toThrow("Invalid signature");
    await expect(client.getProduct(1)).rejects.toMatchObject({ status: 401 });
  });
});
