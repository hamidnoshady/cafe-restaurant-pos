import * as React from "react";
import { Input } from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 360, display: "flex", flexDirection: "column", gap: 12 }}>
    {children}
  </div>
);

export const Default = () => (
  <Shell>
    <Input placeholder="جستجوی کالا…" />
    <Input defaultValue="قهوه اسپرسو" />
  </Shell>
);

export const Types = () => (
  <Shell>
    <Input type="number" placeholder="تعداد" defaultValue={2} />
    <Input type="tel" placeholder="۰۹۱۲۳۴۵۶۷۸۹" />
    <Input type="password" defaultValue="secret" />
  </Shell>
);

export const States = () => (
  <Shell>
    <Input placeholder="غیرفعال" disabled />
    <Input defaultValue="مقدار نامعتبر" aria-invalid={true} />
    <Input defaultValue="فقط‌خواندنی" readOnly />
  </Shell>
);
