import * as React from "react";
import { Button } from "cafe-restaurant-pos";
import { Plus, CreditCard, Trash2, Printer } from "lucide-react";

const Row = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: 16 }}>
    {children}
  </div>
);

export const Variants = () => (
  <Row>
    <Button variant="default">افزودن به سفارش</Button>
    <Button variant="secondary">ذخیره</Button>
    <Button variant="outline">ویرایش</Button>
    <Button variant="ghost">جزئیات</Button>
    <Button variant="destructive">لغو سفارش</Button>
    <Button variant="link">مشاهده فاکتور</Button>
  </Row>
);

export const Sizes = () => (
  <Row>
    <Button size="xs">خیلی کوچک</Button>
    <Button size="sm">کوچک</Button>
    <Button size="default">معمولی</Button>
    <Button size="lg">بزرگ</Button>
  </Row>
);

export const WithIcons = () => (
  <Row>
    <Button variant="default"><Plus /> میز جدید</Button>
    <Button variant="secondary"><Printer /> چاپ رسید</Button>
    <Button variant="destructive"><Trash2 /> حذف قلم</Button>
    <Button size="icon" variant="outline" aria-label="پرداخت"><CreditCard /></Button>
  </Row>
);

export const States = () => (
  <Row>
    <Button variant="default">فعال</Button>
    <Button variant="default" disabled>غیرفعال</Button>
    <Button variant="outline" disabled>غیرفعال</Button>
  </Row>
);
