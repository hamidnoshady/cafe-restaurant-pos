import * as React from "react";
import {
  Select, SelectTrigger, SelectValue, SelectContent,
  SelectItem, SelectGroup, SelectLabel, SelectSeparator,
} from "cafe-restaurant-pos";

export const Closed = () => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 280 }}>
    <Select defaultValue="salon">
      <SelectTrigger>
        <SelectValue placeholder="انتخاب بخش" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="salon">سالن</SelectItem>
        <SelectItem value="terrace">تراس</SelectItem>
        <SelectItem value="vip">اتاق ویژه</SelectItem>
      </SelectContent>
    </Select>
  </div>
);

export const Open = () => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 280, minHeight: 260 }}>
    <Select defaultValue="latte" open>
      <SelectTrigger>
        <SelectValue placeholder="انتخاب نوشیدنی" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>نوشیدنی گرم</SelectLabel>
          <SelectItem value="latte">قهوه لاته</SelectItem>
          <SelectItem value="espresso">اسپرسو</SelectItem>
          <SelectItem value="tea">چای نبات</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>نوشیدنی سرد</SelectLabel>
          <SelectItem value="icecoffee">آیس‌کافی</SelectItem>
          <SelectItem value="lemonade">لیموناد</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  </div>
);
