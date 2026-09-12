## Business Suite — how to build with this design system

A Persian-first (RTL, Jalali, Toman) multi-app business-platform component set built on shadcn/ui +
Radix + Tailwind v4. Components are exported from `window.CafePos.*` (e.g.
`window.CafePos.Button`). Compound components also export their sub-parts from the same
namespace (e.g. `CardHeader`, `TableRow`, `DialogContent`, `SelectItem`) — compose them, never
re-implement.

### Setup & wrapping

- **Styling is automatic** — the design tokens live in `:root` (and `.dark`) in the shipped
  stylesheet, so components render fully styled with no provider. Do NOT wrap in a theme
  provider to get colors.
- **Right-to-left.** This is a Persian-first DS. Set `dir="rtl"` on a top-level container so
  layout, icon sides, and text alignment are correct. Use Persian copy and Persian digits
  (۰۱۲۳…) with Toman amounts (e.g. `۳۶۰٬۰۰۰ تومان`).
- **Dark mode:** add `class="dark"` to an ancestor element — the same tokens flip.
- **Toasts:** mount `<Toaster />` once near the root, then call sonner's `toast()`.
- **Tooltips:** wrap the app (or subtree) in `<TooltipProvider>`; each `Tooltip` holds a
  `TooltipTrigger` + `TooltipContent`.

### Styling idiom — Tailwind v4 utilities + semantic tokens

Style your own layout with Tailwind utility classes. For anything color-bearing, use the
**semantic token utilities** (never raw hex, never `bg-blue-500`) so it stays on-brand and
theme-correct. The brand accent is Persian turquoise (فیروزه‌ای).

| Purpose | Utilities |
|---|---|
| Surfaces | `bg-background`, `bg-card`, `bg-popover`, `bg-muted` |
| Text | `text-foreground`, `text-muted-foreground`, `text-card-foreground` |
| Brand accent | `bg-primary` + `text-primary-foreground`, or `text-primary` |
| Secondary | `bg-secondary` + `text-secondary-foreground` |
| Danger | `bg-destructive`, `text-destructive` |
| Lines & focus | `border-border`, `border-input`, `ring-ring` |
| Radius | `rounded-md`, `rounded-lg` (driven by the `--radius` token) |
| Type | `font-sans` (Vazirmatn — the bundled Persian family) |

Standard Tailwind spacing/flex/grid utilities (`flex`, `gap-2`, `p-4`, `px-2`, `h-8`, …) are
all available. Component-specific looks are chosen via **props**, not classes — e.g.
`<Button variant="destructive" size="sm">`, `<Badge variant="secondary">`,
`<Field orientation="horizontal">`, `<Switch size="sm">`. See each component's `<Name>.d.ts`
for its exact prop unions and its `<Name>.prompt.md` for usage.

### Where the truth lives

- The design system's `styles.css` and `_ds_bundle.css` — the full token set and compiled
  utilities. Read them before inventing any class or color.
- Per-component `<Name>.d.ts` (the API contract) and `<Name>.prompt.md` (usage) — read the
  component's own files before composing it.

### One idiomatic example

```jsx
const { Card, CardHeader, CardTitle, CardAction, CardContent, CardFooter, Button, Badge } = window.CafePos;

<div dir="rtl" className="max-w-md">
  <Card>
    <CardHeader>
      <CardTitle>سفارش میز ۵</CardTitle>
      <CardAction><Badge variant="secondary">در حال آماده‌سازی</Badge></CardAction>
    </CardHeader>
    <CardContent>
      <div className="flex justify-between text-sm">
        <span>قهوه لاته × ۲</span>
        <span className="text-muted-foreground">۱۳۰٬۰۰۰</span>
      </div>
    </CardContent>
    <CardFooter className="gap-2">
      <Button>پرداخت</Button>
      <Button variant="outline">چاپ رسید</Button>
    </CardFooter>
  </Card>
</div>
```
