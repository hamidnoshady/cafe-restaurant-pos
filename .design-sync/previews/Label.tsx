import * as React from "react";
import { Label, Input, Checkbox } from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 360, display: "flex", flexDirection: "column", gap: 14 }}>
    {children}
  </div>
);

export const WithInput = () => (
  <Shell>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label htmlFor="table-name">نام میز</Label>
      <Input id="table-name" defaultValue="میز کنار پنجره" />
    </div>
  </Shell>
);

export const WithCheckbox = () => (
  <Shell>
    <Label htmlFor="takeaway" style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Checkbox id="takeaway" defaultChecked />
      بیرون‌بر
    </Label>
  </Shell>
);
