import * as React from "react";
import { RadioGroup, RadioGroupItem, Label } from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 320 }}>{children}</div>
);

export const OrderType = () => (
  <Shell>
    <RadioGroup defaultValue="dine-in" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Label htmlFor="dine-in" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem value="dine-in" id="dine-in" /> سرو در سالن
      </Label>
      <Label htmlFor="takeaway" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem value="takeaway" id="takeaway" /> بیرون‌بر
      </Label>
      <Label htmlFor="delivery" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <RadioGroupItem value="delivery" id="delivery" /> ارسال با پیک
      </Label>
    </RadioGroup>
  </Shell>
);
