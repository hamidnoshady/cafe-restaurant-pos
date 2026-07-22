import * as React from "react";
import { Alert, AlertTitle, AlertDescription, AlertAction, Button } from "cafe-restaurant-pos";
import { Info, TriangleAlert } from "lucide-react";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 460, display: "flex", flexDirection: "column", gap: 14 }}>
    {children}
  </div>
);

export const Default = () => (
  <Shell>
    <Alert>
      <Info />
      <AlertTitle>پرینتر آشپزخانه متصل است</AlertTitle>
      <AlertDescription>سفارش‌های جدید به‌صورت خودکار برای آشپزخانه چاپ می‌شوند.</AlertDescription>
    </Alert>
  </Shell>
);

export const Destructive = () => (
  <Shell>
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>اتصال به پرینتر قطع شد</AlertTitle>
      <AlertDescription>سفارش‌ها چاپ نمی‌شوند. اتصال دستگاه را بررسی کنید.</AlertDescription>
      <AlertAction>
        <Button size="sm" variant="outline">تلاش مجدد</Button>
      </AlertAction>
    </Alert>
  </Shell>
);
