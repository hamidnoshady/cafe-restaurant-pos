import * as React from "react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuShortcut, Button,
} from "cafe-restaurant-pos";
import { Pencil, Printer, Split, Trash2 } from "lucide-react";

export const OrderActions = () => (
  <div dir="rtl" style={{ padding: 16, minHeight: 260 }}>
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">عملیات سفارش</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" style={{ minWidth: 224 }}>
        <DropdownMenuLabel>سفارش میز ۵</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <Pencil /> ویرایش اقلام
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Printer /> چاپ رسید
          <DropdownMenuShortcut>Ctrl+P</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Split /> تقسیم صورتحساب
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash2 /> لغو سفارش
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);
