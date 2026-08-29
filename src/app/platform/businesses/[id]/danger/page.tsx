"use client";

/**
 * The danger zone, quarantined on its own page.
 *
 * On the old single-page console these two forms sat at the bottom of a long
 * scroll, next to everything else; here they are one deliberate navigation
 * away, red-carded, and capability-gated twice (this section only renders for
 * roles holding `business.reset`/`business.delete`, and the server enforces).
 */
import { InfoBox } from "../../../ui";
import { RemovePanel, ResetPanel } from "../panels";

export default function BusinessDangerPage() {
  return (
    <div className="space-y-4">
      <InfoBox>
        هر دو اقدام فوری و بدون بازگشت‌اند. پیش از آن، «بایگانی» را در نظر بگیرید — حالت معلق هم
        دسترسی را می‌بندد بدون اینکه داده‌ای پاک کند.
      </InfoBox>
      <ResetPanel />
      <RemovePanel />
    </div>
  );
}
