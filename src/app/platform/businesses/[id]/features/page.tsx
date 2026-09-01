"use client";

/** Feature flags, per-business app states, and desktop pairing — everything "what can this tenant use?". */
import { FeaturesPanel } from "../panels";
import { PairingPanel } from "../pairing-panel";
import { BusinessAppAvailabilityPanel } from "../app-availability-panel";

export default function BusinessFeaturesPage() {
  return (
    <div className="space-y-4">
      <FeaturesPanel />
      {/* The second, orthogonal switch: a flag says whether this business is
          entitled to a capability, this says whether the app is released and
          working for them — «به‌زودی», «در حال تعمیر», «نسخهٔ آزمایشی». */}
      <BusinessAppAvailabilityPanel />
      <PairingPanel />
    </div>
  );
}
