"use client";

/**
 * Phase 32 — the «همکار هوشمند» tab: what is waiting for you, what you have
 * delegated, and what the books look like right now, in that order.
 *
 * That order is the argument of the whole phase. Phases 18b and 31 put the
 * assistant's output inside a chat window and a settings page; a coworker's
 * output belongs in an inbox, because the thing an owner does with it every
 * day is decide, not converse.
 */
import { useState } from "react";
import { InfoBox } from "../ui";
import { CoworkerInbox } from "./coworker-inbox";
import { CoworkerJobs } from "./coworker-jobs";
import { CoworkerReview } from "./coworker-review";

export function AiCoworkerPanel({ canAutoApply }: { canAutoApply: boolean }) {
  // Bumped whenever a decision or a job change lands, so the sibling panel
  // reloads without either of them owning the other's state.
  const [, setRevision] = useState(0);
  const bump = () => setRevision((value) => value + 1);

  return (
    <div className="space-y-4">
      <InfoBox>
        کارهای تکرارشوندهٔ حسابداری را یک بار توضیح دهید و بسپارید: «هر شب با پایان شیفت، ماندهٔ نان را ضایعات
        بزن»، «هر روز صبح حساب‌ها را بررسی کن». همکار هوشمند در همان لحظه مقدارها را از انبار و دفتر می‌خواند و
        نتیجه را — بسته به انتخاب شما — یا ثبت می‌کند یا برای تأیید شما می‌گذارد.
      </InfoBox>
      <CoworkerInbox onChange={bump} />
      <CoworkerJobs canAutoApply={canAutoApply} onChange={bump} />
      <CoworkerReview />
    </div>
  );
}
