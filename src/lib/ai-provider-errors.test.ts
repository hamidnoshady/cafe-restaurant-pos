import { describe, expect, it } from "vitest";
import { normalizeProviderError, providerErrorReason, sanitizeProviderText, tenantProviderErrorMessage } from "./ai-provider-errors";

describe("provider error diagnostics", () => {
  it("keeps LiteLLM's actionable reason ahead of a generic HTTP code", () => {
    const error = normalizeProviderError(400, JSON.stringify({
      error: {
        message: "litellm.BadRequestError: OpenAIException - extra_forbidden: mcp_tool_servers. Received Model Group=pos-chat",
        type: "invalid_request_error",
        code: "400",
      },
    }));

    expect(error.code).toBe("400");
    expect(providerErrorReason(error)).toContain("extra_forbidden: mcp_tool_servers");
    expect(providerErrorReason(error)).not.toBe("400");
  });

  it("summarizes FastAPI validation details", () => {
    const error = normalizeProviderError(400, JSON.stringify({
      detail: [
        { loc: ["body", "tools", 0, "function", "name"], msg: "Field required" },
        { loc: ["body", "stream_options"], msg: "Extra inputs are not permitted" },
      ],
    }));

    expect(providerErrorReason(error)).toContain("body.tools.0.function.name: Field required");
    expect(providerErrorReason(error)).toContain("body.stream_options: Extra inputs are not permitted");
  });

  it("redacts bearer and key-shaped secrets from diagnostics", () => {
    const text = sanitizeProviderText(
      'Authorization: Bearer sk-tenant-secret-123, master_key="sk-master-secret-456", api_key=sk-provider-secret-789',
    );

    expect(text).toContain("Bearer [redacted]");
    expect(text).toContain("master_key: [redacted]");
    expect(text).toContain("api_key: [redacted]");
    expect(text).not.toContain("sk-tenant-secret-123");
    expect(text).not.toContain("sk-master-secret-456");
    expect(text).not.toContain("sk-provider-secret-789");
  });

  it("returns tenant-safe 4xx copy without raw provider details", () => {
    expect(tenantProviderErrorMessage(400)).toContain("مدیر پلتفرم");
    expect(tenantProviderErrorMessage(400)).not.toContain("extra_forbidden");
  });
});
