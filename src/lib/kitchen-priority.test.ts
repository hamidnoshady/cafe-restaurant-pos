import { describe, expect, it } from "vitest";
import {
  priorityForKitchenTicket,
  rankKitchenQueue,
} from "./kitchen-priority";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe("Phase 18b Wave 3 kitchen queue priority", () => {
  it("puts overdue tickets ahead of all non-overdue tickets", () => {
    const priority = priorityForKitchenTicket(
      { status: "preparing", sentAt: minutesAgo(10) },
      NOW,
    );
    expect(priority.tier).toBe("overdue");
    expect(priority.isLate).toBe(true);
  });

  it("puts unstarted tickets before in-progress and ready tickets when none are overdue", () => {
    const ranked = rankKitchenQueue(
      [
        { id: "ready", status: "ready" as const, sent_to_kitchen_at: minutesAgo(8) },
        { id: "preparing", status: "preparing" as const, sent_to_kitchen_at: minutesAgo(9) },
        { id: "sent", status: "sent" as const, sent_to_kitchen_at: minutesAgo(1) },
        { id: "late", status: "preparing" as const, sent_to_kitchen_at: minutesAgo(11) },
      ],
      NOW,
    );

    expect(ranked.map((row) => row.id)).toEqual([
      "late",
      "sent",
      "preparing",
      "ready",
    ]);
  });

  it("breaks same-tier ties by oldest sent time and handles a future clock safely", () => {
    const ranked = rankKitchenQueue(
      [
        { id: "newer", status: "sent" as const, sent_to_kitchen_at: minutesAgo(2) },
        { id: "older", status: "sent" as const, sent_to_kitchen_at: minutesAgo(5) },
      ],
      NOW,
    );
    expect(ranked.map((row) => row.id)).toEqual(["older", "newer"]);

    const future = priorityForKitchenTicket(
      { status: "sent", sentAt: new Date(NOW + 60_000).toISOString() },
      NOW,
    );
    expect(future.ageMinutes).toBe(0);
    expect(future.isLate).toBe(false);
  });
});
