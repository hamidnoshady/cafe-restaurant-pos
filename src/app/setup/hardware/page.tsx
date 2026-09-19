"use client";

/**
 * Setup wizard — the hardware step. The printer connection UI is not rebuilt
 * here: the SAME PrintersPanel the Settings → Printers tab renders is embedded
 * whole, so there is exactly one way to pair a printer, learned once. The
 * wizard only adds the step chrome around it; the step is marked done the
 * first time a printer is actually saved.
 */
import { useCallback, useState } from "react";
import { api, InfoBox, StepShell } from "../ui";
import { PrintersPanel } from "@/app/(app)/settings/printing/printers-panel";

export default function HardwareStep() {
  const [savedOnce, setSavedOnce] = useState(false);

  const onPrinterSaved = useCallback(async () => {
    if (savedOnce) return;
    setSavedOnce(true);
    // The step is complete the moment real hardware is paired; marking it
    // here means the operator never has to think about progress at all.
    await api("/api/setup/hardware", { method: "POST", body: JSON.stringify({ done: true }) });
  }, [savedOnce]);

  return (
    <StepShell
      step="hardware"
      description="چاپگر رسید و آشپزخانه را وصل و آزمایش کنید. همین صفحهٔ افزودن چاپگر، جست‌وجوی شبکه و چاپ آزمایشی واقعی دارد."
      showSkip
      showNext
    >
      <InfoBox>
        برای چاپ روی چاپگر USB یا چاپگر نصب‌شده در Windows، در «افزودن چاپگر» گزینهٔ «چاپگر ویندوز» را انتخاب کنید؛ نصب رابط چاپ
        یک‌بار کلی و کاملاً خودکار است. اگر فعلاً چاپگر ندارید، همین مرحله را رد کنید — چاپ با پنجرهٔ مرورگر هم ممکن است.
      </InfoBox>
      <PrintersPanel onChanged={onPrinterSaved} />
    </StepShell>
  );
}
