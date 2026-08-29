"use client";

/** Feature flags + desktop pairing — everything "what can this tenant use?". */
import { FeaturesPanel } from "../panels";
import { PairingPanel } from "../pairing-panel";

export default function BusinessFeaturesPage() {
  return (
    <div className="space-y-4">
      <FeaturesPanel />
      <PairingPanel />
    </div>
  );
}
