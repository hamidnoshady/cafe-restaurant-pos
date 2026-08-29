"use client";

/**
 * The AI section shell.
 *
 * AI settings (provider wiring, pricing, credits, subscriptions, top-up
 * approvals) and the prompt manager used to be two unconnected sidebar
 * entries that crossed fingers-and-links between themselves. They are one
 * job — running the platform's AI service — so they live in one section now:
 * this layout paints the shared header and the tabs, and the sidebar nests
 * the same two entries under «هوش مصنوعی». The pages keep their own state and
 * capability gating; nothing else moves.
 */
import { SubNav } from "../ui";

export default function AiSectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-bold">هوش مصنوعی</h1>
        <p className="mt-1 text-sm text-white/45">
          سرویس واحد AI سکوفر: اتصال، نرخ‌گذاری، اعتبار کسب‌وکارها، اشتراک‌ها و پرامپت‌های سیستمی.
        </p>
      </div>

      <SubNav
        items={[
          { label: "تنظیمات و اشتراک‌ها", href: "/platform/ai", exact: true },
          { label: "پرامپت‌ها", href: "/platform/ai/prompts" },
        ]}
      />

      {children}
    </div>
  );
}
