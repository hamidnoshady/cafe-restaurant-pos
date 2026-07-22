import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 460 }}>{children}</div>
);

export const Default = () => (
  <Shell>
    <Tabs defaultValue="menu">
      <TabsList>
        <TabsTrigger value="menu">منو</TabsTrigger>
        <TabsTrigger value="orders">سفارش‌ها</TabsTrigger>
        <TabsTrigger value="tables">میزها</TabsTrigger>
      </TabsList>
      <TabsContent value="menu" style={{ paddingTop: 12, fontSize: 14 }}>
        مدیریت اقلام منو، دسته‌بندی‌ها و قیمت‌ها.
      </TabsContent>
      <TabsContent value="orders" style={{ paddingTop: 12, fontSize: 14 }}>
        سفارش‌های باز و تاریخچه فروش.
      </TabsContent>
    </Tabs>
  </Shell>
);

export const LineVariant = () => (
  <Shell>
    <Tabs defaultValue="today">
      <TabsList variant="line">
        <TabsTrigger value="today">امروز</TabsTrigger>
        <TabsTrigger value="week">این هفته</TabsTrigger>
        <TabsTrigger value="month">این ماه</TabsTrigger>
      </TabsList>
      <TabsContent value="today" style={{ paddingTop: 12, fontSize: 14 }}>
        گزارش فروش امروز: ۱۲٬۴۵۰٬۰۰۰ تومان
      </TabsContent>
    </Tabs>
  </Shell>
);
