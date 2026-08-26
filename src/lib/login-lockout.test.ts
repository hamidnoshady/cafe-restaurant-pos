import { describe, it, expect } from "vitest";
import { lockoutStatus, PLATFORM_LOCKOUT_POLICY, type LoginAttemptEvent } from "./login-lockout";

describe("login-lockout", () => {
  const now = new Date("2024-01-01T12:00:00Z");

  it("applies a custom policy correctly", () => {
    // Platform policy: 3 fails, 30 min window
    const events: LoginAttemptEvent[] = [
      { action: "failed", createdAt: now },
      { action: "failed", createdAt: new Date(now.getTime() - 60_000) },
      { action: "failed", createdAt: new Date(now.getTime() - 120_000) },
    ];
    
    const status = lockoutStatus(events, PLATFORM_LOCKOUT_POLICY, now);
    expect(status.locked).toBe(true);
    expect(status.failedCount).toBe(3);
    expect(status.lockedUntil).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
  });

  it("distinguishes actions based on policy", () => {
    // If the failedAction is "failed", then "employee.login_failed" breaks the streak
    const events: LoginAttemptEvent[] = [
      { action: "failed", createdAt: now },
      { action: "employee.login_failed", createdAt: new Date(now.getTime() - 60_000) },
      { action: "failed", createdAt: new Date(now.getTime() - 120_000) },
    ];

    const status = lockoutStatus(events, PLATFORM_LOCKOUT_POLICY, now);
    expect(status.locked).toBe(false);
    expect(status.failedCount).toBe(1);
  });
});
