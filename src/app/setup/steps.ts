import type { WizardStep } from "@/lib/setup-state";

export interface StepMeta {
  id: WizardStep;
  path: string;
  title: string;
  short: string;
  optional?: boolean;
}

export const STEPS: StepMeta[] = [
  { id: "business", path: "/setup/business", title: "اطلاعات کسب‌وکار", short: "کسب‌وکار" },
  { id: "accounts", path: "/setup/accounts", title: "سرفصل حساب‌ها", short: "حساب‌ها" },
  { id: "costing", path: "/setup/costing", title: "روش قیمت‌گذاری موجودی", short: "قیمت‌گذاری" },
  { id: "tax", path: "/setup/tax", title: "تنظیم مالیات", short: "مالیات" },
  { id: "users", path: "/setup/users", title: "نقش‌ها و کاربران", short: "کاربران", optional: true },
  { id: "menu", path: "/setup/menu", title: "ورود منو", short: "منو" },
  { id: "hardware", path: "/setup/hardware", title: "اتصال سخت‌افزار", short: "سخت‌افزار", optional: true },
  { id: "opening", path: "/setup/opening", title: "مانده‌های افتتاحیه", short: "افتتاحیه", optional: true },
];

export function stepIndex(id: string): number {
  return STEPS.findIndex((s) => s.id === id);
}

export function nextPath(id: string): string {
  const i = stepIndex(id);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1].path : "/setup/finish";
}

export function prevPath(id: string): string | null {
  const i = stepIndex(id);
  return i > 0 ? STEPS[i - 1].path : null;
}
