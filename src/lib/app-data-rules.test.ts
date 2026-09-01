import { describe, expect, it } from "vitest";
import { APP_KEYS } from "./apps";
import {
  APP_DATA_DOMAINS,
  APP_DATA_RULES,
  appDataRule,
  appUsesData,
  appsUsingData,
  canWriteData,
  dataOwner,
} from "./app-data-rules";

describe("app data ownership rules", () => {
  it("gives every data domain exactly one owner", () => {
    expect(APP_DATA_RULES.map((rule) => rule.domain)).toEqual([...APP_DATA_DOMAINS]);
    expect(new Set(APP_DATA_RULES.map((rule) => rule.domain)).size).toBe(APP_DATA_DOMAINS.length);
    for (const rule of APP_DATA_RULES) {
      expect(APP_KEYS).toContain(rule.owner);
      expect(rule.readers).not.toContain(rule.owner);
      expect(rule.readers).toEqual([...new Set(rule.readers)]);
    }
  });

  it("keeps the canonical customer record in CRM while Growth and Accounting use it", () => {
    expect(dataOwner("customer_records")).toBe("crm");
    expect(appUsesData("growth", "customer_records")).toBe(true);
    expect(appUsesData("accounting", "customer_records")).toBe(true);
    expect(canWriteData("growth", "customer_records")).toBe(false);
    expect(canWriteData("crm", "customer_records")).toBe(true);
  });

  it("keeps WordPress and WooCommerce management in the WP app", () => {
    const rule = appDataRule("wp_store_mirror");
    expect(rule.owner).toBe("wp");
    expect(rule.syncStrategy).toBe("mapped-integration");
    expect(appUsesData("accounting", "wp_store_mirror")).toBe(true);
    expect(appUsesData("wp", "wp_store_mirror")).toBe(true);
    expect(appUsesData("wp", "technical_connections")).toBe(false);
    expect(canWriteData("accounting", "wp_store_mirror")).toBe(false);
    expect(canWriteData("wp", "wp_store_mirror")).toBe(true);
  });

  it("returns the owner first when a workflow needs all permitted apps", () => {
    expect(appsUsingData("ledger_entries")[0]).toBe("accounting");
    expect(appsUsingData("growth_programs")[0]).toBe("growth");
  });
});
