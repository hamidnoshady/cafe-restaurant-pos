import * as React from "react";
import { Badge } from "cafe-restaurant-pos";

const Row = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: 16 }}>
    {children}
  </div>
);

export const OrderStatus = () => (
  <Row>
    <Badge variant="default">پرداخت شده</Badge>
    <Badge variant="secondary">در حال آماده‌سازی</Badge>
    <Badge variant="outline">در انتظار</Badge>
    <Badge variant="destructive">لغو شده</Badge>
  </Row>
);

export const Variants = () => (
  <Row>
    <Badge variant="default">پیش‌فرض</Badge>
    <Badge variant="secondary">ثانویه</Badge>
    <Badge variant="destructive">مخرب</Badge>
    <Badge variant="outline">خط‌دار</Badge>
    <Badge variant="ghost">شبح</Badge>
    <Badge variant="link">پیوند</Badge>
  </Row>
);
