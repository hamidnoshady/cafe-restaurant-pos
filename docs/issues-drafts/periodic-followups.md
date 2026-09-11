# Draft GitHub issues — روش‌های قیمت‌گذاری باقی‌مانده (Phase 43 follow-ups)

Blocked on GitHub auth (token expired mid-session). Create each section below as
its own issue verbatim, then delete this file.

---

## Issue 1 — روش شناسایی ویژه (Specific Identification)

**Title:** `روش قیمت‌گذاری: شناسایی ویژه (Specific Identification)`

**Body:**

پس از Phase 43 (سیستم ادواری + LIFO) روش «شناسایی ویژه» هنوز پیاده نشده است.

### چیست
هر واحد کالا با بهای واقعی خودش رهگیری و در لحظهٔ فروش با همان بها هزینه می‌شود —
مناسب اقلام سریال‌دار و گران‌قیمت (طلا و جواهر، ساعت، ابزار خاص) که این برنامه
صنف‌هایشان را دارد.

### وضع فعلی کد
- زیرساخت نصفه موجود است: مدل خرده‌فروشی سریال/lot دارد
  (`item_batches` + serial در `src/lib/*retail*`), و مدل F&B لایهٔ خرید دقیق دارد
  (`inventory_lots`).
- اما مصرف همیشه با استراتژی سراسری کسب‌وکار (`getCostingStrategy` در
  `src/lib/inventory-costing.ts`) انجام می‌شود؛ هیچ مسیری «این lot مشخص را بفروش»
  ندارد.

### پیشنهاد فنی
1. `specific_identification` به union `CostingMethod` و به radio ویزارد
   (`src/app/setup/costing/page.tsx`) اضافه شود؛ `isLotBased` باید true برگرداند.
2. خط فروش/مصرف باید `lotId` (یا سریال) اختیاری بپذیرد؛
   `consumeInventoryExact` (`src/lib/inventory-consumption-exact.ts`) وقتی lot صریح
   داده شد فقط از همان lot کم کند و در نبودش خطا بدهد (نه fallback به FIFO).
3. UI فروش POS برای اقلام سریال‌دار انتخاب‌گر lot/سریال نشان دهد.
4. `v_inventory_valuation` بدون تغییر کار می‌کند (ارزش = جمع لایه‌های باقی‌مانده).
5. در سیستم ادواری، شمارش پایان دوره باید per-lot ثبت شود
   (`periodic_closing_lines` ستون `lot_ref` اختیاری).

مجاز در استاندارد حسابداری ایران و IAS 2 (برای اقلام غیرقابل‌تعویض حتی الزامی).

---

## Issue 2 — بهای تمام‌شدهٔ استاندارد (Standard Costing)

**Title:** `روش قیمت‌گذاری: بهای استاندارد (Standard Costing) + انحرافات`

**Body:**

### چیست
به هر کالا/مادهٔ اولیه یک «بهای استاندارد» از پیش تعیین می‌شود؛ ورود و خروج انبار
همیشه با استاندارد ثبت و تفاوتِ بهای واقعی خرید با استاندارد در حساب‌های **انحراف**
(انحراف نرخ خرید، انحراف مصرف) شناسایی می‌شود. برای تولید (که برنامه در
`production-service.ts` دارد) ابزار کنترل مدیریتی کلاسیک است.

### وضع فعلی کد
- هیچ مفهوم بهای استاندارد وجود ندارد؛ recipe costing واقعی است
  (`src/lib/recipe-*`، `production-output-costing.ts`).
- گزارش «انحراف بهای غذا» (`buildFoodCostVariance` در `reports-service.ts`)
  نزدیک‌ترین خویشاوند است اما فقط گزارش است، نه ثبت دفتری.

### پیشنهاد فنی
1. ستون `standard_cost_rial` روی `inventory_items` (+ تاریخچهٔ تغییر استاندارد).
2. `standard` به `CostingMethod`؛ `isLotBased` = false (مثل میانگین، بدون لایه).
3. رسید خرید: بدهکار 1300 به استاندارد، تفاوت به حساب جدید «انحراف نرخ خرید»
   (کد پیشنهادی 5905 در `WELL_KNOWN_CODES` + قالب‌های COA + مهاجرت backfill —
   الگوی 5105 در مهاجرت `0144`).
4. مصرف/فروش/تولید: همیشه به استاندارد؛ انحراف مصرف تولید به «انحراف مصرف» (5906).
5. گزارش انحرافات دوره در Reports.
6. طبق IAS 2 فقط وقتی مجاز است که به بهای واقعی نزدیک باشد و مرتب بازنگری شود —
   در UI تذکر داده شود.

---

## Issue 3 — روش خرده‌فروشی (Retail Inventory Method)

**Title:** `روش قیمت‌گذاری: روش خرده‌فروشی (Retail Inventory Method)`

**Body:**

### چیست
موجودی پایان دوره به **قیمت فروش** شمرده و با «نسبت بهای تمام‌شده به خرده‌فروشی»
(cost-to-retail ratio) به بها تبدیل می‌شود. برای خرده‌فروشی با اقلام زیاد و حاشیهٔ
همگن (سوپرمارکت، پوشاک، خرازی — صنف‌هایی که برنامه دارد) روش تخمینی مجاز IAS 2 است.

### وضع فعلی کد
- Phase 43 سیستم ادواری کامل را ساخت (`periodic-closing-service.ts`,
  `periodic-valuation.ts`, جدول‌های `periodic_closings`) — روش خرده‌فروشی طبیعتاً
  یک **روش ارزش‌گذاری چهارم روی همان بستن دوره** است، نه سیستم جدید.
- قیمت فروش اقلام retail موجود است (`items.price`), قیمت خرید در فاکتورها.

### پیشنهاد فنی
1. `retail_method` فقط در ترکیب با `system: "periodic"` قابل انتخاب باشد
   (اعتبارسنجی در `src/app/api/setup/costing/route.ts`).
2. در بستن دوره: کاربر ارزش شمارش را به قیمت فروش وارد می‌کند؛ سرویس نسبت
   بها/خرده‌فروشی دوره را از (اول دوره + خرید به بها) ÷ (اول دوره + خرید به قیمت
   فروش) می‌سازد — یعنی `periodic_closing_lines` ستون‌های retail-value لازم دارد و
   خطوط خرید باید قیمت فروش لحظهٔ خرید را هم نگه دارند.
3. `periodic-valuation.ts` تابع جدید `retailMethodEndingValue()` با تست، کنار
   سه تابع موجود.
4. باقی زنجیره (سند Dr 5100 / بازگویی 1300 / Cr 5105) بدون تغییر از Phase 43
   ارث می‌رسد.

---

## Issue 4 — شفاف‌سازی: «میانگین موزون» فعلی در واقع میانگین متحرک است

**Title:** `شفاف‌سازی نام‌گذاری: weighted_average دائمی = میانگین متحرک (Moving Average)`

**Body:**

### مسئله
روش `weighted_average` در سیستم **دائمی** بعد از هر رسید خرید، میانگین را دوباره
حساب می‌کند (recompute در `purchase-receipt-costing.ts` / منطق average در
`inventory-consumption-exact.ts`). این در ادبیات حسابداری **میانگین متحرک
(Moving Average)** نام دارد؛ «میانگین موزون» کلاسیک یک‌بار در پایان دوره از سرجمع
کل دوره گرفته می‌شود — همان که Phase 43 برای سیستم **ادواری** پیاده کرد
(`weightedAverageEndingValue` در `src/lib/periodic-valuation.ts` — pooled classic).

نتیجه: دو رفتار متفاوت زیر یک نام `weighted_average` در `CostingMethod`، که هم در
UI (label «میانگین موزون» در `setup/costing/page.tsx` و بخش‌های dashboard) و هم در
اسناد گمراه‌کننده است.

### پیشنهاد
- **بدون تغییر رفتار و بدون مهاجرت داده** — فقط نام‌گذاری:
  1. label دائمی در ویزارد و dashboard به «میانگین موزون متحرک (Moving Average)»
     و توضیح کوتاه زیرش؛ label ادواری «میانگین موزون کلاسیک» بماند.
  2. کامنت سر `CostingMethod` در `src/lib/inventory-costing.ts` که صراحتاً بگوید
     `weighted_average` در perpetual یعنی moving average.
  3. `docs/phases/Phase-43-Periodic-Inventory-System-LIFO.md` و README فازها
     ارجاع متقابل بگیرند.
- تغییر خود مقدار enum (`weighted_average` → `moving_average`) پیشنهاد **نمی‌شود**:
  در ستون‌های DB و تنظیمات ذخیره شده و ارزش مهاجرتش را ندارد.
