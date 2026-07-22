import * as React from "react";
import { Separator } from "cafe-restaurant-pos";

export const Horizontal = () => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 320 }}>
    <div style={{ fontWeight: 600 }}>اطلاعات فاکتور</div>
    <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>شماره ۱۰۲۴</div>
    <Separator style={{ margin: "12px 0" }} />
    <div style={{ fontSize: 14 }}>جمع کل: ۳۶۰٬۰۰۰ تومان</div>
  </div>
);

export const Vertical = () => (
  <div dir="rtl" style={{ padding: 16, display: "flex", alignItems: "center", gap: 12, height: 40 }}>
    <span>سالن</span>
    <Separator orientation="vertical" />
    <span>آشپزخانه</span>
    <Separator orientation="vertical" />
    <span>صندوق</span>
  </div>
);
