/**
 * The case response clock.
 *
 * The property worth defending here is that **time spent waiting on the
 * customer does not count against the team**. Get that wrong and the SLA
 * report becomes actively harmful: it reports failures that are not failures,
 * so it gets ignored; it makes "never ask the customer a question" the fastest
 * way to protect the number; and it buries the handful of genuinely-neglected
 * cases among false positives.
 *
 * These are pure-function tests with an injected `now`, so they assert the
 * arithmetic without a clock or a database.
 */
import { describe, expect, it } from "vitest";
import { caseSla } from "./crm-case-service";

const HOUR = 3600 * 1000;
const NOW = new Date("2026-03-15T12:00:00Z");

function at(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
}

describe("waiting on the customer pauses the clock", () => {
  it("does not breach when the whole overrun was the customer's silence", () => {
    // Urgent: a four-hour target. The case is ten hours old, but eight of
    // those were spent waiting for the customer to send their order number.
    // Two hours are the team's. That is not a breach, and reporting it as one
    // would be blaming the team for a customer's holiday.
    const sla = caseSla({
      priority: "urgent",
      status: "waiting",
      openedAt: at(10),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: at(8),
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(2 * 3600);
    expect(sla.breached).toBe(false);
    expect(sla.waitingOnCustomer).toBe(true);
  });

  it("breaches when the overrun is genuinely the team's", () => {
    // Same ten-hour-old urgent case, nobody waiting on anybody. This one is
    // real, and it is the case that must not be buried among false positives.
    const sla = caseSla({
      priority: "urgent",
      status: "open",
      openedAt: at(10),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(10 * 3600);
    expect(sla.breached).toBe(true);
    expect(sla.remainingSeconds).toBeLessThan(0);
  });

  it("accumulates across several separate waits", () => {
    // A case that bounced: waited, came back, waited again. Both stretches
    // count. Deriving this from the current status would be impossible — the
    // column only knows where the case is now, which is why the total is
    // stored rather than computed.
    const sla = caseSla({
      priority: "normal", // 72h
      status: "in_progress",
      openedAt: at(50),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 30 * 3600,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(20 * 3600);
    expect(sla.breached).toBe(false);
  });

  it("counts the in-flight wait on top of the stored total", () => {
    // waiting_seconds is only closed out on the way back to an active status,
    // so a case sitting in `waiting` right now has a stretch not yet in it.
    // Ignoring that would make a currently-waiting case look progressively
    // later the longer the customer stays silent.
    const sla = caseSla({
      priority: "normal",
      status: "waiting",
      openedAt: at(50),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 20 * 3600,
      waitingSince: at(10),
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(20 * 3600);
  });
});

describe("the clock stops when it should", () => {
  it("stops at resolution, not at page load", () => {
    // Resolved in three hours against a four-hour target. Nobody closing the
    // browser tab for a week must not turn that into a breach.
    const sla = caseSla({
      priority: "urgent",
      status: "resolved",
      openedAt: at(200),
      firstResponseAt: at(198),
      resolvedAt: at(197),
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(3 * 3600);
    expect(sla.breached).toBe(false);
  });

  it("judges a responded case on its response, not its current age", () => {
    // Answered within the hour; still open two weeks later because the fix is
    // slow. The *response* promise was kept, and that is what this target
    // measures. Marking it breached would conflate two different promises.
    const sla = caseSla({
      priority: "urgent",
      status: "in_progress",
      openedAt: at(336),
      firstResponseAt: at(335),
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.firstResponseSeconds).toBe(3600);
    expect(sla.breached).toBe(false);
  });

  it("reports a slow first response as a breach", () => {
    const sla = caseSla({
      priority: "urgent",
      status: "in_progress",
      openedAt: at(48),
      firstResponseAt: at(20),
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.firstResponseSeconds).toBe(28 * 3600);
    expect(sla.breached).toBe(true);
  });
});

describe("edge cases that would otherwise produce nonsense", () => {
  it("never reports negative active time", () => {
    // Clock skew between app servers, or a hand-edited row. A negative age
    // would render as «-۳ ساعت» and make the whole screen untrustworthy.
    const sla = caseSla({
      priority: "normal",
      status: "open",
      openedAt: new Date(NOW.getTime() + 5 * HOUR).toISOString(),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(0);
  });

  it("survives waiting time exceeding elapsed time", () => {
    // Should not happen, but a bad backfill or a double-counted stretch would
    // do it, and the answer must be zero rather than a negative.
    const sla = caseSla({
      priority: "normal",
      status: "in_progress",
      openedAt: at(5),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 100 * 3600,
      waitingSince: null,
      now: NOW,
    });
    expect(sla.activeSeconds).toBe(0);
    expect(sla.breached).toBe(false);
  });

  it("falls back to a sane target for an unrecognised priority", () => {
    const sla = caseSla({
      priority: "bogus" as never,
      status: "open",
      openedAt: at(1),
      firstResponseAt: null,
      resolvedAt: null,
      waitingSeconds: 0,
      waitingSince: null,
      now: NOW,
    });
    // 72h — the normal target. Never zero, which would breach instantly and
    // mark every case in the business as late.
    expect(sla.targetHours).toBe(72);
    expect(sla.breached).toBe(false);
  });
});
