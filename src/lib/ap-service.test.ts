import { describe, it, expect } from "vitest";
import { ApError } from "./ap-service";

describe("ApError", () => {
  it("should extend Error", () => {
    const error = new ApError("some_code");
    expect(error).toBeInstanceOf(Error);
  });

  it("should set the message to the provided code", () => {
    const error = new ApError("custom_error_code");
    expect(error.message).toBe("custom_error_code");
  });

  it("should have a default status of 400", () => {
    const error = new ApError("some_code");
    expect(error.status).toBe(400);
  });

  it("should set a custom status when provided", () => {
    const error = new ApError("some_code", 404);
    expect(error.status).toBe(404);
  });
});
