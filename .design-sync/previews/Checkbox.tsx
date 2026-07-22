import * as React from "react";
import { Checkbox, Label } from "cafe-restaurant-pos";

const Item = ({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Checkbox>) => (
  <Label htmlFor={id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <Checkbox id={id} {...props} />
    {label}
  </Label>
);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
    {children}
  </div>
);

export const States = () => (
  <Shell>
    <Item id="c1" label="افزودن شکر" defaultChecked />
    <Item id="c2" label="بدون یخ" />
    <Item id="c3" label="حالت نامشخص" checked="indeterminate" />
    <Item id="c4" label="گزینه غیرفعال" disabled />
    <Item id="c5" label="غیرفعال و انتخاب‌شده" disabled defaultChecked />
  </Shell>
);
