"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { XIcon } from "lucide-react";

export function SetupBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!window.localStorage.getItem("hideSetupBanner")) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="mb-4 flex flex-col items-start gap-3 rounded-2xl border border-primary/25 bg-primary/[0.045] px-4 py-3.5 text-sm text-primary shadow-[0_2px_7px_rgb(41_37_36/0.04)] transition-colors hover:bg-primary/[0.075] sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex flex-1 items-start gap-3 sm:items-center">
        <span>
          <b>راه‌اندازی اولیه کامل نشده است.</b> برای آماده‌شدن جهت ثبت سفارش،
          جادوگر راه‌اندازی را تکمیل کنید.
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        <Link href="/setup" className="font-semibold hover:underline">
          ادامهٔ راه‌اندازی ←
        </Link>
        <button
          type="button"
          aria-label="بستن"
          className="rounded-full p-1 text-primary/70 hover:bg-primary/10 hover:text-primary transition-colors"
          onClick={() => {
            window.localStorage.setItem("hideSetupBanner", "true");
            setVisible(false);
          }}
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
