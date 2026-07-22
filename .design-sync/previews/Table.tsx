import * as React from "react";
import {
  Table, TableHeader, TableBody, TableFooter,
  TableRow, TableHead, TableCell, TableCaption,
} from "cafe-restaurant-pos";

export const OrderSummary = () => (
  <div dir="rtl" style={{ padding: 16 }}>
    <Table>
      <TableCaption>سفارش میز ۵ — نشسته در سالن</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>کالا</TableHead>
          <TableHead>تعداد</TableHead>
          <TableHead>قیمت واحد</TableHead>
          <TableHead>جمع</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>قهوه لاته</TableCell>
          <TableCell>۲</TableCell>
          <TableCell>۶۵٬۰۰۰</TableCell>
          <TableCell>۱۳۰٬۰۰۰</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>کیک شکلاتی</TableCell>
          <TableCell>۱</TableCell>
          <TableCell>۹۵٬۰۰۰</TableCell>
          <TableCell>۹۵٬۰۰۰</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>چای نبات</TableCell>
          <TableCell>۳</TableCell>
          <TableCell>۴۵٬۰۰۰</TableCell>
          <TableCell>۱۳۵٬۰۰۰</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={3}>جمع کل (تومان)</TableCell>
          <TableCell>۳۶۰٬۰۰۰</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  </div>
);
