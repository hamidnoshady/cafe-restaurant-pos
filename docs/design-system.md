# Design system — the app's visual canon

**This document is the normative description of what the product looks like.** It is backed
by the reference screenshots in [`docs/design/reference/`](design/reference/) — those images
are the ground truth; when prose and screenshot disagree, match the screenshot. The classes
quoted here are copied from the shared primitives, which are the other normative half:

- [`src/app/dashboard/page-chrome.tsx`](../src/app/dashboard/page-chrome.tsx) — `PageShell`,
  `PageHeader`, `SectionCard`/`cardClass`, `overlayPanelClass`/`popoverPanelClass`,
  `TabBar`/`TabPanel`, `EmptyState`, `StatusBadge`, and the skeleton family
  (`LoadingSkeleton`, `SectionCardSkeleton`, `KpiRowSkeleton`, `DashboardPageSkeleton`)
- [`src/app/dashboard/section-nav.tsx`](../src/app/dashboard/section-nav.tsx) — the in-page
  rail/strip menu
- [`src/app/dashboard/ui.tsx`](../src/app/dashboard/ui.tsx) — `inputClass`, `Field`,
  `ErrorBox`, `InfoBox`
- [`src/components/ui/*`](../src/components/ui/) — shadcn layer (`Button`, `Input`, …)
- [`src/app/globals.css`](../src/app/globals.css) — the tokens

**Never restate these classes by hand when a primitive exists — compose the primitive.**
The recipes below exist so an agent can *recognise* the language and so a restyle is one
edit, not because copying them into a page is acceptable.

## Reference screenshots

| File | Shows |
| --- | --- |
| [accounting-trial-balance.png](design/reference/accounting-trial-balance.png) | Settings rail nav (amber active pill + dot), data table on warm header wash, «متوازن» green badge, Toman amounts in Persian digits |
| [ledger-expense-form.png](design/reference/ledger-expense-form.png) | Amber eyebrow over card title, form grid of fields/selects, recent-expenses table, dashed empty state |
| [ledger-expense-combobox.png](design/reference/ledger-expense-combobox.png) | SearchableSelect open: teal focus ring on the search input, white popover panel, checkmark on the selected option |
| [pos-sell-screen.png](design/reference/pos-sell-screen.png) | POS exception chrome: category chips (amber active), amber dashed product cards, solid amber CTA, dense icon-led sidebar |
| [reservations.png](design/reference/reservations.png) | Filter chips row (amber active), selects, rich empty states (amber icon chip + bold title + muted line), dashed placeholder panel |
| [settings.png](design/reference/settings.png) | Grouped rail nav («کسب‌وکار / مالی و فروش / مدیریت» labels), card stacks, unit toggle where the active choice is amber-100 |
| [dashboard-overview.png](design/reference/dashboard-overview.png) | KPI stat cards with amber icon chips and extrabold numbers, amber bar chart with dashed loading skeleton, green live pill |

## The language in one paragraph

A warm stone canvas slightly darker than the white cards that sit on it, separated by
one-pixel warm hairlines and a one-pixel warm shadow — nothing floats. Everything is
generously rounded (`rounded-2xl` cards, `rounded-xl` controls and pills, `rounded-full`
badges). Type is Vazirmatn, Persian-first RTL; headings are bold near-black on warm stone
mids; every displayable number is a Persian digit. **Amber is selection** (active nav, tabs,
chips, focus rings on navigation, emphasis, warnings); **teal is the brand** (filled buttons,
links, focus rings on form controls); green and red are reserved for success and danger.
Hovers are quiet washes, never overlays or zooms. Motion is short, eased and functional:
150–650 ms, ease-out, opacity/transform/color only, skeleton shimmer while loading, no bounce.

## Realms — where the language applies

1. **Dashboard** (`src/app/dashboard/**`) — this document, fully. Built from the primitives.
2. **Full-screen operational surfaces** (POS, orders queue, floor plan, KDS, reservations) —
   same palette, denser chrome, smaller headers, touch-height targets. See
   [pos-sell-screen.png](design/reference/pos-sell-screen.png). Not `PageHeader` pages —
   but still framed by `PageShell` or its equivalents in `ops-styles.ts`, which composes
   `cardClass`.
3. **Entry surfaces** (`src/app/login`, `src/app/welcome`, `src/app/setup`,
   `src/app/invite`, `src/app/mcp/consent`, `src/app/business-directory.tsx`, the root
   fallbacks) — the screens every business type walks before it ever reaches حسابداری.
   Same language: a centred `cardClass` panel on the warm canvas, amber selection,
   `FormLoadingSkeleton` while resolving, busy buttons that swap their label. They import
   the primitives from `@/app/dashboard/page-chrome` — there is exactly one design system,
   not one per realm.
4. **Platform console** (`src/app/platform/**`) — deliberately a separate identity with its
   own `ui.tsx` (a darker chrome, so an operator never mistakes it for a tenant screen).
   Excluded from the lint on purpose.
5. **The shadcn layer** (`src/components/ui/*`) — change tokens/variants there, never
   one-off classes at call sites. The rest of `src/components/**` (AI chat, auth, bug
   report, feature lock) is tenant-facing and speaks this language.

## Foundations

### Canvas and surfaces

| What | Value |
| --- | --- |
| Page canvas | `--background: oklch(0.975 0.002 90)` — warm off-white, a touch darker than cards |
| Card surface | pure white, `bg-card` |
| Card skin (`cardClass`) | `rounded-2xl border border-stone-200/80 bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)]` |
| Page column | `PageShell` = `mx-auto w-full max-w-[1600px]` |
| Inner washes | `bg-stone-50` (table headers), `bg-stone-50/60` (card footers) |

The canvas/card contrast is the entire elevation system: a card is *lighter* than its
background plus a 1px hairline plus a 1px warm shadow. No `shadow-sm`/`md`/`lg`, no layered
shadows, no hover lift on cards.

### Weight (borders and shadows)

- **Hairlines are 1px and warm**: `border-stone-200/80` between surfaces, `border-stone-100`
  (`border-border` = `oklch(0.922 0.004 60)`) between rows. Dividers under card headers and
  footers are the same hairline — never a heavier rule.
- **The card shadow is exactly** `shadow-[0_1px_2px_rgb(41_37_36/0.035)]` — warm stone ink at
  3.5%. TabBar's active pill carries `shadow-[0_1px_2px_rgb(120_53_15/0.08)]` (warm amber ink).
- **No border heavier than 1px anywhere.** Emphasis comes from fill (amber-100), not stroke
  weight. Amber-200 borders (`border-amber-200`) frame an active control; that's the only
  "colored border" rule.
- Popovers/dropdowns are the one exception with a visible shadow: `shadow-md` on a
  `rounded-lg border border-border bg-popover` panel.

### Floating surfaces — the only sanctioned elevation above a card

Modals, statement panels, the assistant sheet and floating docks are the one place the
language allows more than a one-pixel shadow. Their skins are stated once in
`page-chrome.tsx` and composed, never restated:

| Surface | Primitive | Skin |
| --- | --- | --- |
| Modal / side statement panel | `overlayPanelClass` | `rounded-2xl border border-stone-200/80 bg-card shadow-[0_12px_32px_-6px_rgb(41_37_36/0.18)]` |
| Dropdown popover (date picker, inline menus) | `popoverPanelClass` | `rounded-lg border border-border bg-popover text-popover-foreground shadow-md` |
| Floating action dock (assistant, bug report) | — | `shadow-[0_12px_32px_-6px_rgb(41_37_36/0.25)]` + `ring-1 ring-foreground/10` |

Scrims stay quiet: `bg-black/40` for modal sheets, `bg-background/95 backdrop-blur-sm` for
in-product locks. Everything else sits on the canvas — `shadow-sm`/`lg`/`2xl` anywhere
outside these three rows (and the shadcn layer) is drift the lint will fail.

### Radius scale (`--radius: 0.625rem`)

| Token | Size | Used for |
| --- | --- | --- |
| `rounded-lg` | 10px | buttons, inputs, selects, textareas, popovers, table wrapper panels |
| `rounded-xl` | 14px | tab pills, nav items, chips, dashed empty states, inner panels, mobile bars |
| `rounded-2xl` | 18px | **cards, section cards, tab strip container, icon chips** |
| `rounded-full` | pill | status badges, live pills, dots, avatar circles |

Cards are always `rounded-2xl`; controls are always `rounded-lg`; interactive pills are
always `rounded-xl`. Don't mix (no `rounded-md` buttons, no `rounded-3xl` cards).

### Typography, digits and direction

- **Vazirmatn everywhere** (`--font-sans`; fallback Tahoma). RTL at the root; use logical
  utilities (`text-start`, `ps-`/`pe-`, `start-`/`end-`), never `left`/`right`. A forward
  chevron points **left** (`ChevronLeftIcon`).
- Page title: `text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]`.
- Card/section title: `font-semibold text-stone-950` (base size).
- **Amber eyebrow** above a card title: `text-xs font-semibold text-amber-700` — the small
  category line («عملیات هزینه», «سوابق عملیاتی») that introduces a card.
- Body: `text-sm text-stone-700`; supporting copy: `text-sm text-muted-foreground`;
  metadata/labels-of-groups: `text-[11px] font-semibold tracking-wide text-stone-400`.
- Table money/number cells: `font-medium` or `font-semibold`, Persian digits, unit spelled
  out («تومان» / «ریال»); time columns get `tabular-nums`.
- **Persian digits are display-only** (`toPersianDigits` from `@/lib/digits`); money text via
  `formatMoneyText` (`@/lib/money`). Never hand-format currency; never print Latin digits in
  a label.
- Descriptions live *under* titles, one line, `mt-1`/`mt-2`, max-width capped (`max-w-3xl`).

### Iconography

Lucide line icons only. Sidebar/rail icons `size-[18px]` (inactive `text-stone-400`, active
`text-amber-800`); in-form icons `size-4 text-muted-foreground`; empty-state icons sit in a
tinted chip (below). Icons are `aria-hidden` when the label is adjacent text.

## Colour roles

| Role | Classes / value | Where |
| --- | --- | --- |
| Neutrals | `stone-*` scale only; `text-stone-950` headings, `text-stone-600/700` body, `text-stone-400` disabled/labels, `bg-stone-50` wash, `border-stone-200/80` hairlines | everything structural |
| Selection / emphasis | `bg-amber-100 text-amber-950` (+ `font-semibold`); frames `border-amber-200`; focus `ring-amber-400/40`; deep amber accent text `text-amber-700/800` | active nav, tabs, chips, unit toggles, eyebrow, warning banners |
| Brand | `--primary: oklch(0.52 0.1 205)` teal; `bg-primary text-primary-foreground hover:bg-primary/80` | filled `<Button>`, links, assistant FAB |
| Focus (forms) | `--ring: oklch(0.62 0.09 205)` teal — `focus-visible:border-ring ring-3 ring-ring/50` | inputs, selects, buttons |
| Success | `bg-emerald-100 text-emerald-900` badges; live dot `bg-emerald-500` + pulse | «متوازن», «پرسرویس آن شد», sync chip |
| Danger | `--destructive: oklch(0.577 0.245 27.325)`; soft fills only: `bg-destructive/10 text-destructive`, banners `border-destructive/30 bg-destructive/5` | destructive actions, errors |
| Charts | `--chart-1…8` fixed categorical palette; operational charts render **amber-family**: bars `fill-amber-200`, trend `stroke-amber-600`, gridlines `stroke-stone-100`, axis labels `text-stone-400` | never a rainbow; never re-order the palette |
| Categorical status coding | the rare board state that needs a hue beyond selection/success/danger («bill requested», info callouts) draws from the **same chart palette**: violet states → `chart-7`, informational blues → `chart-1`, as `bg-chart-N/5 border-chart-N/25 text-chart-N` chips | never a new accent scale (no violet/sky/indigo Tailwind families) |

Two accents per screen, maximum: amber *or* teal leading, with green/red only for state.
A third decorative accent is drift.

## Component recipes

Exact classes, copied from the primitives. Compose the component; these are the reference
for what it renders and for the few places a bespoke layout is warranted.

### Page frame

```tsx
<PageShell>                      // mx-auto w-full max-w-[1600px]
  <PageHeader title description actions />
  // header: text-2xl font-bold tracking-tight text-stone-950, description
  // mt-2 max-w-3xl text-sm leading-6 text-muted-foreground,
  // whole thing mb-5 border-b border-stone-200/80 pb-5 sm:mb-6 sm:pb-6
  <SectionCard title description actions footer flush>…</SectionCard>
</PageShell>
```

Card header (from `SectionCard`): `px-4 py-4 sm:px-5`, title `font-semibold text-stone-950`,
description `mt-1 text-xs leading-5 text-muted-foreground`, hairline underneath
(`border-b border-stone-200/80`); footer `bg-stone-50/60 text-xs text-stone-600`.
An optional amber eyebrow sits above the title:
`<p className="text-xs font-semibold text-amber-700">…</p>` then the `<h2>` with `mt-1`.

### Rail navigation (settings, accounting, connections)

A `cardClass` card, sticky at `lg` (`w-[280px]`), items min-height 48px:

```tsx
// item
"flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-right text-sm transition-colors
 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40"
// active:   "bg-amber-100 font-semibold text-amber-950"   icon: "text-amber-800"
// inactive: "text-stone-600 hover:bg-stone-50 hover:text-stone-950"  icon: "text-stone-400"
// active dot: <span className="size-1.5 rounded-full bg-amber-700" />
// group label: "px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-stone-400"
```

The phone gets a drill-down (menu page → section page with a «بازگشت» bar) — that's
`SectionNav`, not something to re-invent.

### Tab pills (`TabBar`)

Container: `cardClass` + `p-2`; pills `min-h-[52px] rounded-xl px-3 sm:px-4 text-sm font-medium`:

```tsx
// active:   "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
// inactive: "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950"
// focus:    "focus-visible:ring-3 focus-visible:ring-amber-400/40"
```

### Chips / filters / segmented toggles

Same amber contract as tabs, smaller. Default chip:

```tsx
// base:      "min-h-[44px] rounded-xl border border-stone-200 bg-white px-3 text-xs text-stone-700
//             transition-colors hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950
//             focus-visible:border-amber-500 focus-visible:ring-amber-400/30"
// active:    "border-amber-200 bg-amber-100 text-amber-950 font-semibold"
```

POS category chips are the same recipe at `min-h-[52px]`. A segmented toggle (تومان/ریال،
ساعتی/تجمعی) is two chips where the inactive side is borderless (`text-stone-600
hover:bg-stone-50`) and the active is `bg-amber-100 text-amber-950` — a quiet fill, never
`bg-stone-900 text-white`, never teal.

### Buttons (`<Button>`)

`rounded-lg text-sm font-medium transition-all … active:translate-y-px
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` — **teal ring on
buttons, amber ring on navigation**. Variants:

| Variant | Skin |
| --- | --- |
| `default` (primary) | `bg-primary text-primary-foreground hover:bg-primary/80` — teal fill |
| `outline` | `border-border bg-background hover:bg-muted` |
| `ghost` | `hover:bg-muted` |
| `secondary` | `bg-secondary hover:bg-secondary+5% ink` |
| `destructive` | soft: `bg-destructive/10 text-destructive hover:bg-destructive/20` |
| destructive row action | `ghost` + `text-destructive hover:bg-destructive/10 hover:text-destructive` |

Sizes: `h-10` default, `h-9 sm`, `h-11 lg`, `h-7 xs`; icon-only `size-10/9/7`. Full-width
form submit is `PrimaryButton` (teal, `w-full px-5 font-semibold`); its pair `SecondaryButton`
is outline. Disabled = `opacity-50 pointer-events-none`, never a gray repaint.

**POS exception:** the empty-cart CTA is solid amber (`bg-amber-300 text-amber-950`,
`rounded-xl`, full width) because on the sell screen amber is the "do the main thing" color;
everywhere else the filled button is teal. Don't port the amber button to dashboard pages.

### Inputs, selects, textareas

`inputClass` (also the `<select>` and textarea skin):

```tsx
"h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm
 transition-colors outline-none placeholder:text-muted-foreground
 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
```

- Label above via `<Field>`: `text-sm font-medium text-foreground`, `mb-1`; optional hint
  below `text-xs text-muted-foreground`; optional marker `(اختیاری)` as
  `<span className="font-normal text-muted-foreground">(اختیاری)</span>` inside the label.
- Numeric inputs are `dir="ltr" inputMode="numeric"` with a Persian-digit placeholder «۰».
- A `<select>` gets `inputClass` plus a chevron (`ChevronDownIcon size-4 text-muted-foreground`)
  at the inline-end; open state adds `data-[state=open]:border-ring`.
- Focus is **teal** (`--ring`), 3px ring at ~50%: the single most recognizable form state in
  the app. Never blue, never amber on form controls.

### SearchableSelect (entity picker)

Trigger = `inputClass` skin (`h-10 rounded-lg border-input … data-[state=open]:border-ring`),
placeholder «انتخاب کنید…», chevron inline-end. Panel:
`rounded-lg border border-border bg-popover text-popover-foreground shadow-md`, width of the
trigger, `sideOffset={4}`; search row `border-b border-border p-2` with
`SearchIcon` at `start-2.5` inside an `h-8` input; options `min-h-11 rounded-md px-2.5 py-1.5
text-sm text-start` with hover/keyboard-active `bg-accent`, and a `CheckIcon size-4` at the
inline-end of the selected option. Empty: `px-2.5 py-2 text-sm text-muted-foreground`.

### Tables

```tsx
<table className="w-full text-sm">
  <thead>
    <tr className="border-b border-border">
      <th className="py-3 pe-3 text-start …last:pe-0">…</th>   // header cells
```

- Header cells: `text-start text-xs sm:text-sm font-medium text-stone-500`, on a warm wash
  when the table is inside a `flush` card or a boxed panel: `bg-stone-50`.
- Body rows: `border-b border-border` (last row `border-b-0`), `py-3`, `text-stone-700`;
  money cells `font-medium`/`font-semibold` with Persian digits + unit.
- **Row hover** (clickable rows): `transition-colors hover:bg-stone-50/70` — a quiet warm
  wash, plus `focus-visible:ring-2 focus-visible:ring-amber-400/45` and a press
  `active:scale-[0.99]` when the row is a link. An *emphasised/selected* row takes
  `bg-amber-50/60` — amber is selection, also in tables.
- Tables live edge-to-edge in a `flush` `SectionCard`, or inside an inner
  `overflow-hidden rounded-xl border border-stone-200/80` panel. Never bare on the canvas.

### Status badges and live pills

`StatusBadge`: `inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium`
— tones: `active` = `bg-amber-100 text-amber-950`, `positive` = `bg-emerald-100
text-emerald-900`, `neutral` = `bg-stone-100 text-stone-600`, `danger` = `bg-destructive/10
text-destructive`. A leading dot (`size-1.5 rounded-full bg-current`) is optional. The
dashboard's live pill («پرسرویس آن شد») is the positive tone plus `gap-1.5` and a pulsing
green ring (`ops-sync-pulse`).

### Empty states

Simple (`EmptyState`): `rounded-xl border border-dashed border-stone-200 px-3 py-6
text-center text-sm text-muted-foreground`. Rich (see
[reservations.png](design/reference/reservations.png)): a centered column inside a dashed
panel — an amber icon chip `grid size-12 place-items-center rounded-2xl bg-amber-100/70
text-amber-700`, title `text-sm font-semibold text-stone-900`, one-line description
`mt-1 text-xs text-muted-foreground`. Both forms name what will exist here, in Persian,
with a leading verb («هنوز هزینه‌ای ثبت نشده است.»).

### Stat / KPI cards (dashboard)

`cardClass` card, generous padding: icon chip `grid size-12 place-items-center rounded-2xl
bg-amber-100/70 text-amber-800`; label `text-sm text-stone-500`; value `text-2xl
font-extrabold tracking-tight text-stone-950` (Persian digits); footnote `mt-1 text-xs
text-stone-400`. The chart beneath renders in the amber chart family with a dashed skeleton
until data lands.

### Banners

- Warning / setup: `rounded-2xl border border-amber-500/25 bg-amber-500/[0.075] px-4 py-3.5
  text-sm text-amber-800` (hover deepen `bg-amber-500/[0.12]` if it's a link row).
- Info: `<InfoBox>` = `border-primary/30 bg-primary/5` with a teal icon.
- Error: `<ErrorBox>` = `border-destructive/30 bg-destructive/5`, icon + `text-destructive`.
  Both carry their own `mb-4`.

### Charts and loading

- Operational charts (dashboard): bars `fill-amber-200` growing from the baseline
  (staggered ~45 ms), trend line `stroke-amber-600 strokeWidth="2.4" strokeLinecap="round"`,
  gridlines `stroke-stone-100` 1px, axis labels `text-[10px] sm:text-xs text-stone-400` —
  the amber family, nothing else.
- Loading is **skeleton, not spinner** — everywhere, on any element that waits:
  - lists/tables: `LoadingSkeleton` / `SectionCardSkeleton` (`page-chrome.tsx`), or a
    bespoke `*Skeleton` component (e.g. `ReservationSkeleton`, `SetupDataSkeleton`);
  - KPI rows: `KpiRowSkeleton`; whole routes: `DashboardPageSkeleton` /
    `PlatformPageSkeleton` / `FormLoadingSkeleton` for entry forms;
  - text rows may use the `.ops-skeleton` shimmer; charts show dashed amber placeholders;
  - tables show 3–4 skeleton rows in the same column grid.
- A button whose action is in flight **swaps its label** («در حال ثبت…», «در حال ورود…»)
  and disables — it never grows a spinner. `animate-spin` is not in the vocabulary and the
  lint bans it.
- A lone «در حال بارگذاری…» sentence is not a loading state; the sentence belongs on the
  skeleton's `aria-label`, the shape belongs to the skeleton.

## Interaction states — the contract

| State | Navigation (nav, tabs, chips, table rows) | Forms & buttons |
| --- | --- | --- |
| Hover | `bg-stone-50` wash (+ `text-stone-950`); chips add `border-amber-300 bg-amber-50` | `bg-primary/80`, `bg-muted`, `bg-destructive/20` |
| Focus-visible | `ring-3 ring-amber-400/40` (tabs/nav/chips) or `ring-2 ring-amber-400/45` (rows) | `border-ring ring-3 ring-ring/50` — teal |
| Active/pressed | amber fill `bg-amber-100 text-amber-950 font-semibold`; rows `active:scale-[0.99]` | `active:translate-y-px` |
| Open (menus) | trigger `data-[state=open]:border-ring`; panel `shadow-md` | — |
| Selected (in list) | checkmark inline-end; row `bg-amber-50/60` in tables | `CheckIcon size-4` |
| Disabled | `opacity-50` + no pointer events, no color change | same |

Hovers never scale, shadow-lift, translate, or darken beyond the washes above. If a hover
needs a comment to explain, it's wrong.

## Motion

Vocabulary (all defined in `globals.css`, all gated on `prefers-reduced-motion`):

| Effect | Spec |
| --- | --- |
| State transitions | `transition-colors` (150 ms default ease) on every interactive color change; buttons `transition-all` |
| Press | buttons `translate-y-px`; big touch targets `scale-[0.98/0.99]` |
| Enter | `.ops-card-enter` 220 ms `cubic-bezier(0.2, 0.8, 0.2, 1)`, scale 0.98→1 + fade |
| List rows | `.ops-order-row` 200 ms translateY 8px→0, staggered ~60 ms |
| Chart bars | `.ops-chart-bar` 540 ms scaleY from baseline, staggered ~45 ms |
| Chart line | `.ops-chart-line` 620 ms draw |
| Live pulse | `.ops-sync-pulse` 650 ms expanding green ring |
| Sync spin | `.ops-sync-rotate` 600 ms on the refresh icon while in flight |
| Skeleton | `.ops-skeleton` 1200 ms warm-gray shimmer loop |
| Popovers | appear immediately (Radix default); a `shadow-md` panel, no entrance animation required |

Rules: 150–650 ms; ease-out family (`cubic-bezier(0.2, 0.8, 0.2, 1)`); move ≤ 8px; animate
opacity/transform/color only; stagger siblings, never animate them in unison; no bounce,
no elastic, no parallax, no hover zoom. `prefers-reduced-motion: reduce` kills all of it —
globally in `globals.css`, and ops components additionally check `matchMedia` before
staggering.

## The old look — never reintroduce

The app had a previous dialect. If a screen looks like any of these, it is a regression:

- **Cool neutrals** — `gray-*`, `slate-*`, `zinc-*`, `neutral-*` classes, blue-tinted
  borders or shadows (`rgb(15 23 42 / …)`). Neutrals are `stone-*` / the warm tokens.
- **Heavy card chrome** — `shadow-sm`/`shadow-md`/`shadow-lg` on cards, 2px borders,
  `border-stone-300` frames, dark headers on tables (`bg-stone-800 text-white`).
- **Light-only colour classes** — dark mode IS supported. A hardcoded neutral
  (`stone-*`, solid `bg-white`) or accent/status colour (`amber-*`, `emerald-*`,
  `rose-*`, `red-*`, `sky-*`) with no theme token and no paired `dark:` shade
  renders a light chip on a dark surface. Express neutrals with the tokens
  (`bg-card`, `text-foreground`, `border-border`, `muted-*` — they flip
  automatically) and pair the amber/status palettes with a `dark:` shade. The
  only fixed-surface exceptions are TOTP/QR images (always white) and the
  camera viewfinder (always black).
- **Wrong accents** — a selected chip as `bg-stone-900 text-white` or teal-filled; a filled
  dashboard button in amber (that's the POS's alone); blue focus rings; a third accent color
  on one screen.
- **Sharp or mismatched corners** — `rounded-md` buttons, `rounded-lg` cards, mixed radii in
  one component.
- **Motion that performs** — hover zoom, 500 ms+ transitions, bounce/elastic easing, spinners
  where a skeleton belongs.
- **Hand-rolled chrome** — a page spelling its own header spacing, tab pills or card border
  instead of composing `page-chrome.tsx` (this is how the old look happened in the first
  place).
- **Latin digits or raw currency integers in labels** — Persian digits via `toPersianDigits`,
  money via `formatMoneyText`.

**Raw hex classes are banned by the lint** (`design-lint.test.ts`), because a hex is the old
dialect's spelling of a token: it dodges restyles and drifts from the palette. The entire
dashboard — ledger, reports, overviews, POS and every board — is normalized; there is no
baseline. When you meet a legacy hex anywhere, translate it with this table — nearest
token, alpha preserved:

| Legacy | Token | Legacy | Token |
| --- | --- | --- | --- |
| `#FCFBF8` `#FCFCFA` `#FFFEFC` | `stone-50` | `#252522` | `stone-950` |
| `#F8F7F4` `#F7F6F2` `#F5F3EE` `#F3F2EF` `#F3EEE3` `#F1EFEA` `#F0EEE9` | `stone-100` | `#5E5B55` `#52504B` | `stone-600` |
| `#EAE8E2` `#DEDAD2` `#EEECE7` `#E8E4DD` | `stone-200/80` | `#77756F` | `stone-500` |
| `#FFF1D8` | `amber-100` | `#8B8A85` `#9C9A94` `#9A9891` | `stone-400` |
| `#FFF9EE` `#FFF8EA` `#FFF7E8` `#FFF3DE` `#FFF6E6` | `amber-50` | `#B7B4AD` | `stone-400` |
| `#F0D7A8` `#F2D097` `#E6D4AF` `#F7DCA9` | `amber-200` | `#D95757` | `destructive` |
| `#E9A11B` `#D9910E` | `amber-500` | `#B42318` `#A23C3C` `#9E4437` | `destructive` |
| `#C9840D` `#C98712` `#C88411` | `amber-600` | `#FDECEC` | `destructive/10` |
| `#B97905` `#A96800` `#9B6700` | `amber-700` | `#EBC4C1` `#E5CCC5` | `destructive/30` |
| `#8C5B00` `#8A5C00` | `amber-800` | `#FFF7F4` | `destructive/5` |
| `#3A290B` | `amber-950` | `#36B56A` | `emerald-500` |
| `#F6FCF8` `#E7F6EC` `#EFFAF3` `#EAF8EF` `#ECF8F0` `#F1FBF3` `#F3FCF6` `#E7F1E9` | `emerald-50` | `#23834A` `#1E7A45` `#155B33` `#246B43` `#258A4C` `#267044` `#2E7D32` `#2F6B41` | `emerald-700` |
| `#D8F0E1` | `emerald-100` | `#EEF2FF` (the one indigo chip) | `primary/10` |
| `#BDE4CB` `#B7DDC6` `#B7DFC6` `#B9E3C8` | `emerald-200` | `#3F4CA8` | `primary` |
| `#B57400` | `amber-700` | `#8A3126` `#9C3328` `#7E241C` | `red-800` |
| `#5B4214` `#6E4800` `#6E5A24` `#6F4600` `#76500A` | `amber-900` | `#2B2418` | `stone-900` |
| `#D9AE5B` `#E9C16B` | `amber-300` | `#D68D00` `#D99110` `#D99314` `#DB9612` | `amber-500` |
| `#FFEDCB` `#FFF0CF` `#F8F0D8` | `amber-100` | `#FFF3DB` `#FFF4DE` `#FFF6E7` `#FFFCF1` `#FFFCF5` | `amber-50` |
| `#67645E` `#8D8A82` `#8B8780` `#8A5A50` | `stone-500` | `#99958D` `#A8A49A` `#B9B6AE` `#9A8670` `#9C9992` | `stone-400` |
| `#D8D5CE` `#D9D6CF` `#DDD9D1` `#DEDAD1` `#E1DDD5` `#E5E1D8` | `stone-200/80` | `#F0EFEB` `#F2F0EB` `#F4F2ED` `#F5F4F1` `#F6F5F1` `#F7F5F0` | `stone-100` |
| violet status coding: `#6B3B8D` `#72518E` `#8B5BAF` | `chart-7` | `#F7F2FC` `#FAF4FF` `#F1E5FB` | `chart-7/5` |
| blue status coding: `#4B7D9B` `#35647D` | `chart-1` | `#F1F8FC` `#C7DCE8` | `chart-1/5` `chart-1/25` |

## Checking your work

The bans on this page are **executable**, and there is no baseline anywhere — every file
must pass every rule:

- `src/app/dashboard/design-lint.test.ts` greps every non-test dashboard file for the
  banned patterns (cool neutrals, heavy shadows, restated card/page skins, light-only colour
  classes with no token/`dark:` counterpart, raw hex, solid `bg-white` off a QR image,
  comma-rgba shadow spellings, `animate-spin`, bare loading copy, a bare `<h1>` on a route),
  and checks that **every dashboard route carries the frame** —
  `PageShell` in the page or in a component it imports.
- `src/app/design-lint.test.ts` holds the same line on every other tenant-facing surface:
  login, welcome, setup, invite, consent, the business directory and `src/components`
  (minus the shadcn layer and the deliberately separate platform console).
- `src/app/loading-coverage.test.ts` requires a skeleton boundary above every layout realm,
  and that every client component which starts a fetch also renders a `*Skeleton`.

Run the lints with:

```bash
npx vitest run src/app/dashboard/design-lint.test.ts src/app/design-lint.test.ts src/app/loading-coverage.test.ts
```

The equivalent greps, if you want to see the violations yourself:

```bash
grep -rn 'shadow-sm\|shadow-md\|shadow-lg' src/app/dashboard/ src/app/login src/app/welcome src/app/setup && echo "card shadow drifted"
grep -rnE 'text-(gray|slate|zinc|neutral)-|bg-(gray|slate|zinc|neutral)-' src/app/dashboard/ && echo "cool neutral drifted"
grep -rnE -- '-\[#[0-9a-fA-F]{3,8}\]' src/app/dashboard/ && echo "raw hex drifted"
grep -rn 'animate-spin' src/app/dashboard/ src/app/login src/app/welcome src/app/components && echo "spinner drifted"
grep -rnE '(bg|text|border)-stone-[0-9]|(?<!/)bg-white\b' src/app/dashboard/ src/app/login src/app/welcome src/app/setup src/app/components | grep -v 'dark:' && echo "light-only colour drifted (dark mode)"
grep -rn 'mx-auto w-full max-w-\[' src/app/dashboard/ --include='*.tsx' | grep -v page-chrome && echo "PageShell bypassed"
grep -rn '<h1' src/app/dashboard/ --include='page.tsx' && echo "PageHeader bypassed"
```

And the visual check: build the page, open it next to the matching reference screenshot, and
compare the *states* — hover a row, focus an input, press a chip. The language is in the
states as much as in the shapes.

Reference screenshots of the normalized screens, captured from the running app, live in
[`docs/design/verification/`](design/verification/) — they were compared against the
references here (palette + states) as the acceptance check for the token normalization.
They are captures of the seeded demo data, not production data.
