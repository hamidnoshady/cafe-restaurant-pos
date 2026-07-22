import * as React from "react";
import {
  Card, CardHeader, CardTitle, CardDescription, CardAction,
  CardContent, CardFooter, Button, Badge, Separator,
} from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 420 }}>{children}</div>
);

export const OrderCard = () => (
  <Shell>
    <Card>
      <CardHeader>
        <CardTitle>سفارش میز ۵</CardTitle>
        <CardDescription>سالن — ۳ قلم</CardDescription>
        <CardAction>
          <Badge variant="secondary">در حال آماده‌سازی</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
          <span>قهوه لاته × ۲</span>
          <span>۱۳۰٬۰۰۰</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 6 }}>
          <span>کیک شکلاتی × ۱</span>
          <span>۹۵٬۰۰۰</span>
        </div>
        <Separator />
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, marginTop: 8 }}>
          <span>جمع کل</span>
          <span>۲۲۵٬۰۰۰ تومان</span>
        </div>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button>پرداخت</Button>
        <Button variant="outline">چاپ رسید</Button>
      </CardFooter>
    </Card>
  </Shell>
);

export const CompactCard = () => (
  <Shell>
    <Card size="sm">
      <CardHeader>
        <CardTitle>فروش امروز</CardTitle>
        <CardDescription>۲۲ تیر ۱۴۰۴</CardDescription>
      </CardHeader>
      <CardContent>
        <div style={{ fontSize: 24, fontWeight: 700 }}>۱۲٬۴۵۰٬۰۰۰ تومان</div>
      </CardContent>
    </Card>
  </Shell>
);
