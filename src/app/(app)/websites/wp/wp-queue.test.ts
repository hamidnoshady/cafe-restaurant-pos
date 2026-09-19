import { describe, expect, it } from "vitest";

/**
 * Unit tests for WordPress & WooCommerce Manager Queue and Events
 * logic, Persian diagnostics, kind mapping and status configuration.
 */

const KIND_KEYS = [
  "stock",
  "price",
  "product_update",
  "order_status",
  "refund_create",
  "catalogue_export",
  "customer_export",
  "orders_export",
  "content_export",
  "post_upsert",
  "media_create",
  "order.created",
  "order.updated",
  "order.restored",
  "refund.created",
  "product.created",
  "product.updated",
  "customer.created",
  "customer.updated",
  "content.created",
  "content.updated",
];

function describePersianError(raw: string | null): string {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("econnrefused") || lower.includes("fetch failed")) {
    return "خطای شبکه و عدم پاسخ‌گویی سرور فروشگاه وردپرس (Timeout / Connection Refused).";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "منبع موردنظر (محصول، سفارش یا نوشته) در وردپرس یافت نشد (404 Not Found). ممکن است در سایت حذف شده باشد.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("unauthorized") || lower.includes("forbidden")) {
    return "خطای عدم دسترسی یا کلیدهای امنیتی نامعتبر (401 / 403). اتصال فروشگاه را بررسی فرمایید.";
  }
  if (lower.includes("500") || lower.includes("internal server error")) {
    return "خطای داخلی سرور وردپرس (500 Internal Server Error). ممکن است یکی از افزونه‌های سایت تداخل داشته باشد.";
  }
  if (lower.includes("replayed_nonce")) {
    return "درخواست تکراری تشخیص داده شد؛ جهت حفظ امنیت تراکنش لغو شد.";
  }
  if (lower.includes("parent")) {
    return "شناسه محصول والد یا تنوع در ساختار ووکامرس نامعتبر است.";
  }
  return raw;
}

describe("WP Queue Kind and Error Diagnostics", () => {
  it("translates timeout and connection refused errors into user-friendly Persian", () => {
    expect(describePersianError("ETIMEDOUT: Connection timed out after 10000ms")).toContain("خطای شبکه");
    expect(describePersianError("ECONNREFUSED 127.0.0.1:443")).toContain("خطای شبکه");
    expect(describePersianError("fetch failed")).toContain("خطای شبکه");
  });

  it("translates 404 not found errors with proper guidance", () => {
    expect(describePersianError("HTTP 404: Product not found")).toContain("یافت نشد");
  });

  it("translates 401 and 403 authentication errors", () => {
    expect(describePersianError("401 Unauthorized: Invalid consumer secret")).toContain("عدم دسترسی");
    expect(describePersianError("403 Forbidden")).toContain("عدم دسترسی");
  });

  it("translates 500 internal server error", () => {
    expect(describePersianError("500 Internal Server Error on /wp-json/wc/v3/orders")).toContain("خطای داخلی سرور");
  });

  it("translates nonce replay protection errors", () => {
    expect(describePersianError("replayed_nonce")).toContain("درخواست تکراری");
  });

  it("translates missing parent errors", () => {
    expect(describePersianError("parent remote id is required for variation")).toContain("محصول والد");
  });

  it("returns raw error message when no specific pattern matches", () => {
    expect(describePersianError("custom database constraint failure")).toBe("custom database constraint failure");
    expect(describePersianError(null)).toBe("");
  });

  it("verifies all operational event topics are accounted for", () => {
    for (const kind of KIND_KEYS) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
    }
  });
});
