export interface LockoutPolicy {
  threshold: number;
  windowMinutes: number;
  failedAction: string;
}

export const EMPLOYEE_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  windowMinutes: 15,
  failedAction: "employee.login_failed",
};

export const PASSWORD_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 5,
  windowMinutes: 15,
  failedAction: "failed", // wait, what should this be? 'failed' in auth_login_attempts
};

export const PLATFORM_LOCKOUT_POLICY: LockoutPolicy = {
  threshold: 3,
  windowMinutes: 30,
  failedAction: "failed",
};

export interface LoginAttemptEvent {
  action: string;
  createdAt: Date | string;
}

export interface LockoutStatus {
  locked: boolean;
  failedCount: number;
  lockedUntil: string | null;
}

export function lockoutStatus(
  events: LoginAttemptEvent[],
  policy: LockoutPolicy = EMPLOYEE_LOCKOUT_POLICY,
  now: Date = new Date(),
): LockoutStatus {
  let failedCount = 0;
  for (const event of events) {
    if (event.action !== policy.failedAction) break;
    failedCount += 1;
  }
  if (failedCount < policy.threshold) {
    return { locked: false, failedCount, lockedUntil: null };
  }
  const mostRecentFailedAt = new Date(events[0].createdAt);
  const lockedUntil = new Date(mostRecentFailedAt.getTime() + policy.windowMinutes * 60_000);
  if (lockedUntil.getTime() <= now.getTime()) {
    return { locked: false, failedCount, lockedUntil: null };
  }
  return { locked: true, failedCount, lockedUntil: lockedUntil.toISOString() };
}
