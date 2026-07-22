import * as React from "react";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader,
  DialogFooter, DialogTitle, DialogDescription, DialogClose,
  Button,
} from "cafe-restaurant-pos";

export const ConfirmCancel = () => (
  <div dir="rtl" style={{ padding: 16, minHeight: 320 }}>
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>لغو سفارش میز ۵؟</DialogTitle>
          <DialogDescription>
            با لغو این سفارش، همه اقلام حذف می‌شوند و این عمل قابل بازگشت نیست.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter style={{ gap: 8 }}>
          <DialogClose asChild>
            <Button variant="outline">انصراف</Button>
          </DialogClose>
          <Button variant="destructive">لغو سفارش</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
);

export const Trigger = () => (
  <div dir="rtl" style={{ padding: 16 }}>
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">باز کردن گفتگو</Button>
      </DialogTrigger>
    </Dialog>
  </div>
);
