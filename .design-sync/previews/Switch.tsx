import * as React from "react";
import { Switch, Label } from "cafe-restaurant-pos";

const Item = ({ id, label, ...props }: { id: string; label: string } & React.ComponentProps<typeof Switch>) => (
  <Label htmlFor={id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
    <Switch id={id} {...props} />
    {label}
  </Label>
);

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
    {children}
  </div>
);

export const States = () => (
  <Shell>
    <Item id="s1" label="نمایش در منو" defaultChecked />
    <Item id="s2" label="فقط بیرون‌بر" />
    <Item id="s3" label="غیرفعال" disabled />
  </Shell>
);

export const Sizes = () => (
  <Shell>
    <Item id="s4" label="کوچک" size="sm" defaultChecked />
    <Item id="s5" label="معمولی" size="default" defaultChecked />
  </Shell>
);
