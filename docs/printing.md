# چاپ و فاکتور — the printing section

Everything a business prints — receipts, invoices, kitchen tickets, labels —
goes through one model, one renderer and one section of the dashboard
(«تنظیمات» → «چاپ و فاکتور», `/dashboard/settings?tab=printers`).

## The idea in one paragraph

A **template is data**, not code: a paper, a handful of options, and an ordered
list of blocks. `src/lib/print-template.ts` defines that model, ships five
built-in templates written in it, and holds the one pure function
(`renderPrintTemplate`) that turns a template + a document into a complete HTML
page. Everything else — the gallery, the designer's live preview, the server's
ESC/POS raster, the browser's print dialog, the A4 print — consumes that one
string. There is no second implementation of the layout anywhere, which is why
"it looked right in the preview" is a true statement about what prints.

## Hardware: one question, two answers

A printer is reached one of exactly two ways, and which one it is is the only
hardware question the product ever asks («چاپگر کجاست؟»):

| Connection | Reached by | Needs |
| --- | --- | --- |
| `windows` | the Cafe POS Windows connector → the Windows spooler (RAW), by queue name | the printer installed in Windows' «Printers & scanners» |
| `network` | the same local connector → raw TCP to the printer's address (port 9100) | the printer on the café LAN |

That is the whole list. USB thermal printers install in Windows and are
`windows`; LAN/Wi-Fi ESC/POS printers are `network`. There is no WebUSB, no
raw device path, no driver-mode picker, no «چاپ با مرورگر» transport, and no
Node.js anywhere on the cashier's machine — those were implementation details
a restaurant employee should never have to understand, and they are gone.

### The delivery flow

```
POS / Order / Kitchen
   │ printerId
   ▼
authenticated app server  (POST /api/printing/print)
   │ loads the printer for the caller's branch from the DB
   │ renders the canonical document (Persian shaping, template, paper width)
   │ packs it into ESC/POS bytes
   ▼
browser  (src/lib/printing/client.ts)
   │ forwards the bytes + the resolved target
   ▼
Cafe POS Windows connector  (127.0.0.1:9123, exact-origin)
   │
   ├── windows  → native winspool.drv, RAW
   └── network  → TCP, port 9100
   ▼
physical printer
```

The split follows what each side actually has. The **app server** owns
authorization, the saved printer, templates and the Chromium raster pipeline
(Persian/RTL text needs a real browser engine — see `src/lib/escpos.ts`; it is
never rendered as ESC/POS text-mode). The **cashier's machine** owns the
hardware: the local connector is the only thing that enumerates Windows
queues, sweeps the café LAN for printers, and sends bytes to a device.

Because of that split the server never accepts a hardware address from a
browser: a print job carries only a `printerId`, and the server resolves it
against the authenticated business + active location. A hand-edited request
can neither aim the server at an arbitrary IP or queue, nor print through
another branch's printer. The server does not scan the café LAN, ever —
network discovery runs inside the connector.

### The Windows connector

`public/windows/cafe-pos-print-connector.ps1` — protocol v3, dependency-free
Windows PowerShell, installed per-user from «چاپگرها → افزودن چاپگر» with one
click (the authenticated installer is built by `src/lib/windows-print-connector.ts`
and served from `/api/printing/connector/installer`). It:

- binds only to `127.0.0.1:9123` — never exposed to the LAN;
- accepts browser requests only from the exact tenant origin baked into the
  installer;
- enumerates installed queues via `Win32_Printer` (`GET /printers/windows`);
- discovers network printers by scanning its own IPv4 /24 subnets for an open
  9100, windowed and deduplicated (`POST /printers/network/discover`);
- probes a target (`POST /printers/probe`);
- delivers raw bytes through the native `winspool.drv` `WritePrinter` API or a
  TCP socket (`POST /print/raw`), returning canonical error codes
  (`printer_not_found`, `network_unreachable`, …) — never raw exceptions.

Reinstalling is also the upgrade path: the installer stops the previous
connector (including the pre-v3 «print agent» spelling), replaces the script,
and only reports success for a v3+ health answer. It starts now and at every
Windows login; no Node.js, no admin account, no command line.

### Browser printing is an output, not a connection

`printViaBrowser` (a hidden iframe, not a popup) opens the browser's own print
dialog. It is the right output for A4/A5 invoices, label sheets, and tills
with no configured hardware printer — and it is never saved as a printer
connection type. Sheets never ride the thermal connector at all.

### Legacy printers

Rows written by the old five-transport model are normalised in
`src/lib/printing/types.ts`: `system` → `windows`, `network` (and pre-transport
rows with an address) → `network`. Everything else (`usb`, `webusb`,
`browser`, and the setup wizard's pre-transport stubs) is flagged
`needsReconnect` with its identity preserved, so the settings screen shows
«این چاپگر باید دوباره متصل شود» and the operator re-pairs in one pass.
Migration 0155 performs the same mapping in the database; new writes go
through a parser (`src/lib/printing/printer-input.ts`) that accepts only the
canonical model.

## The pieces

| File | What it is |
| --- | --- |
| `src/lib/print-template.ts` | Papers, the block model, the five built-ins, `parsePrintTemplate` (the write boundary) and `renderPrintTemplate` (the only renderer). Pure. |
| `src/lib/print-sample.ts` | The sample document every preview and test print uses. Pure. |
| `src/lib/print-templates-service.ts` | The branch's own saved templates (`print_templates`, migration 0145). |
| `src/lib/business-logo.ts` | Logo validation + the stored record. Pure. |
| `src/lib/printing/types.ts` | The canonical connection model, the legacy normalisation and target validation. Pure. |
| `src/lib/printing/printer-input.ts` | The one parser both printer routes write through (canonical model only). Pure. |
| `src/lib/printing/errors.ts` | The canonical error codes and their Persian sentences. Pure. |
| `src/lib/printing/render-service.ts` | The server half: load the saved printer for the branch, render a job to ESC/POS bytes. Server-only. |
| `src/lib/printing/chromium.ts` | HTML → PNG with the embedded Vazirmatn font (server-side). Server-only. |
| `src/lib/printing/raster.ts` | PNG → grayscale decode. Pure. |
| `src/lib/printing/client.ts` | The browser's printing client: connector calls, printerId-scoped jobs, the browser-dialog fallback. |
| `src/app/api/printing/print` | The one hardware job endpoint: printerId in, canonical bytes + target out. |
| `src/app/api/printing/test-draft` | The add-printer wizard's test print before the printer is saved. |
| `src/app/api/printing/connector/installer` | Authenticated per-origin Windows connector installer download. |
| `public/windows/cafe-pos-print-connector.ps1` | The one Windows hardware gateway: queue discovery, LAN discovery, probe, RAW/TCP delivery. |
| `src/app/(app)/settings/printing/**` | The section: gallery, designer, printers panel (shared with the setup wizard), logo. |

## Papers

`thermal58`, `thermal80`, `a4`, `a5`, `label57x40`. A paper knows its width in
millimetres, whether it is a roll / a cut sheet / a label, its default margin,
and — for the roll kinds — the pixel width the ESC/POS raster is screenshotted
at (58mm → 372px, 80mm → 512px; unchanged). Adding a sixth paper is one entry
in `PAPERS`; nothing else has a paper list.

## The five built-in templates

They are code, never rows, so a business can never break one. A shop
**duplicates** one to get a template it can edit.

1. **فیش فروش ۸۰ میلی‌متری** — the standard café/restaurant receipt.
2. **فیش فشردهٔ ۵۸ میلی‌متری** — the same document tightened for a small roll.
3. **فاکتور رسمی A4** — ruled seven-column table, buyer block with economic
   code, two signature slots, optional two-copy printing.
4. **فاکتور A5 (پیک و تحویل)** — half-sheet delivery invoice.
5. **سفارش آشپزخانه ۸۰ میلی‌متری** — large, bold, priceless.

## Designing a template

The designer is deliberately **not** a free-positioning canvas. A receipt is one
column on a fixed-width roll and an invoice is a header/table/totals stack; free
positioning on either only lets somebody build something that prints wrong. So
the editor is a reorderable list of blocks — each one can be hidden, aligned,
resized, bolded, and (for the items table) given its own columns — beside a
live preview at true paper size. That is workable with a keyboard, on a touch
screen and on a phone, and it cannot produce a template the renderer refuses.

Everything written is normalised by `parsePrintTemplate` first, so a stored
`layout` can only contain blocks, columns and option values the renderer
understands. Out-of-range numbers are clamped, unknown columns dropped, custom
text truncated.

## The logo

Uploaded in the section's «لوگو» tab, stored in `settings` under
`business.logo` as a **data URL** (`src/lib/business-logo.ts`). Inline rather
than a file path because the server renders receipts in a headless browser —
anything the page needs has to travel inside the HTML. Hard 256 KB cap, four
allowed types, byte-signature checked, and an SVG carrying `<script>` is
refused outright.

## Pairing a printer (the operator's path)

The «چاپگرها» tab lists the branch's printers as cards — name, purpose,
connection, target, status (probed through the connector when the page opens,
never on an interval), default badge — with **Test print** and **Edit**. All
configuration lives inside the add/edit dialog:

1. **چاپگر کجاست؟** — «چاپگر ویندوز» (on this computer; recommended for USB)
   or «چاپگر شبکه» (LAN/Wi-Fi).
2. **انتخاب چاپگر** — Windows: the connector lists the installed queues.
   Network: it sweeps the local subnets; manual IP/port appears only behind
   «چاپگرتان پیدا نشد؟». If the connector is missing, the same step installs
   it with one click («اتصال این کامپیوتر»).
3. **این چاپگر چه کاری انجام می‌دهد؟** — name, receipts vs kitchen tickets,
   80/58mm paper, cash drawer (receipt printers only), default for the
   purpose; the template picker sits under «تنظیمات پیشرفته».

A test print runs before or during save («چاپ آزمایشی و ذخیره»), so a wrong
pairing is caught here — never discovered as a failed print at the counter.
The first-run setup wizard's hardware step embeds the *same* panel
(`printers-panel.tsx`); there is exactly one way to pair a printer.

Printing is best-effort by contract: a failed receipt print never invalidates
a completed sale. The POS shows a non-destructive warning with «چاپ دوباره».

## Cash drawer

The drawer hangs off the receipt printer, exactly as the ESC/POS `ESC p`
command expects: a printer configured with «بازکردن کشوی پول» kicks it after
a receipt (the POS kicks it whenever a payment includes cash). Drawer test
lives in the printer's Edit dialog. There is deliberately no separate
"cash drawer connection" architecture.

## Defaults

One default printer per purpose (receipt / kitchen) per branch, enforced
transactionally in `/api/settings/printers` when a default is saved. The POS
picks the default for the kind automatically; nobody configures routing
tables.

## Errors

Every failure maps to one canonical code (`connector_not_installed`,
`connector_outdated`, `printer_not_found`, `printer_inactive`,
`printer_offline`, `network_unreachable`, `print_failed`, `render_failed`,
`reconnect_required`, …) defined in `src/lib/printing/errors.ts`, each with
its Persian sentence. Screens show the sentence, never the raw exception —
technical detail goes to the server log and the connector's own log file
(`%LOCALAPPDATA%\CafePOS\PrintConnector\connector.log`: startup, version,
print attempts, spooler/TCP failures, probe failures — never receipt
content).

**Chromium for rendering.** The server renders with `playwright-core` against
an existing browser: `PRINT_CHROMIUM_PATH` (or `PDF_CHROMIUM_PATH`) if set,
otherwise the machine's own Chrome/Edge/Chromium is auto-detected
(`src/lib/printing/chromium.ts`).

## Testing

`src/lib/print-template.test.ts` renders every built-in and asserts on the
output string: Persian digits, Toman amounts, no Gregorian dates, escaped item
names, the ruled table's columns, two-copy pages on a sheet but never on a
roll, and that `starterTemplate` cannot alias the preset it copied.
`escpos.test.ts` pins the byte stream (raster packing, cut, drawer kick,
58/80mm widths); `printing/raster.test.ts` the PNG decode; `printing/types.test.ts`
and `printing/printer-input.test.ts` the model and its write boundary;
`printing/render-service.test.ts` the render pipeline; `printing/client.test.ts`
the browser client; `windows-print-connector*.test.ts` the connector/installer
contract; `api/printing/**` the route security model; and
`integration/printer-connection-migration.integration.test.ts` migration 0155
on a real database.

## Adding to the model

- **A new block type** — add it to `BlockType`/`BLOCK_LABELS`, render it in
  `renderBlock`, and add it to the designer's `ADDABLE` list. The parser picks
  it up from `BLOCK_LABELS` automatically.
- **A new paper** — one entry in `PAPERS`.
- **A new built-in template** — one entry in `BUILT_IN_TEMPLATES`; the gallery,
  the paper filter and the printer's template picker all read from it.
