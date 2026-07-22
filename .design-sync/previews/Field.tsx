import * as React from "react";
import {
  Field, FieldLabel, FieldContent, FieldDescription, FieldError,
  Input, Switch,
} from "cafe-restaurant-pos";

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div dir="rtl" style={{ padding: 16, maxWidth: 420, display: "flex", flexDirection: "column", gap: 20 }}>
    {children}
  </div>
);

export const WithDescription = () => (
  <Shell>
    <Field>
      <FieldLabel htmlFor="item-name">نام کالا</FieldLabel>
      <Input id="item-name" defaultValue="قهوه لاته" placeholder="مثلاً کاپوچینو" />
      <FieldDescription>این نام روی منو و رسید چاپ می‌شود.</FieldDescription>
    </Field>
  </Shell>
);

export const Invalid = () => (
  <Shell>
    <Field data-invalid={true}>
      <FieldLabel htmlFor="price">قیمت (تومان)</FieldLabel>
      <Input id="price" defaultValue="0" aria-invalid={true} />
      <FieldError errors={[{ message: "قیمت باید بیشتر از صفر باشد." }]} />
    </Field>
  </Shell>
);

export const Horizontal = () => (
  <Shell>
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor="in-menu">موجود در منو</FieldLabel>
        <FieldDescription>در صورت خاموش بودن، این کالا برای فروش نمایش داده نمی‌شود.</FieldDescription>
      </FieldContent>
      <Switch id="in-menu" defaultChecked />
    </Field>
  </Shell>
);
