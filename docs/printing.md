# چاپ و فاکتور — the printing section

Everything a business prints — receipts, invoices, kitchen tickets, labels —
goes through one model, one renderer and one section of the dashboard
(«تنظیمات» → «چاپ و فاکتور», `/dashboard/settings?tab=printers`).

## The idea in one paragraph

A **template is data**, not code: a paper, a handful of options, and an ordered
list of blocks. `src/lib/print-template.ts` defines that model, ships five
built-in templates written in it, and holds the one pure function
(`renderPrintTemplate`) that turns a template + a document into a complete HTML
page. Everything else — the gallery, the designer's live preview, the print
agent's raster, the browser's print dialog, the A4 PDF — consumes that one
string. There is no second implementation of the layout anywhere, which is why
"it looked right in the preview" is a true statement about what prints.

## The pieces

| File | What it is |
| --- | --- |
| `src/lib/print-template.ts` | Papers, the block model, the five built-ins, `parsePrintTemplate` (the write boundary) and `renderPrintTemplate` (the only renderer). Pure. |
| `src/lib/print-sample.ts` | The sample document every preview and test print uses. Pure. |
| `src/lib/print-templates-service.ts` | The branch's own saved templates (`print_templates`, migration 0145). |
| `src/lib/business-logo.ts` | Logo validation + the stored record. Pure. |
| `src/lib/printer-connection.ts` | The four transports and how a `printers.connection` row is read. Pure. |
| `src/lib/printer-input.ts` | The one parser both printer routes write through. Pure. |
| `src/lib/print-agent-client.ts` | Talking to the local agent, **and** the browser-dialog fallback. |
| `print-agent/discovery.ts` | Windows/CUPS queue enumeration + the LAN sweep. |
| `print-agent/spooler.ts` | Raw ESC/POS to a queue or device; PDF to a sheet queue. |
| `src/app/dashboard/settings/printing/**` | The section: gallery, designer, hardware, logo. |

## Papers

`thermal58`, `thermal80`, `a4`, `a5`, `label57x40`. A paper knows its width in
millimetres, whether it is a roll / a cut sheet / a label, its default margin,
and — for the roll kinds — the pixel width the ESC/POS raster is screenshotted
at. Adding a sixth paper is one entry in `PAPERS`; nothing else has a paper
list.

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
than a file path because the print agent renders in a headless browser with no
session and often no route back to the app server — anything the page needs has
to travel inside the HTML. Hard 256 KB cap, four allowed types, byte-signature
checked, and an SVG carrying `<script>` is refused outright.

## Printers: four transports

| Transport | Reached by | Needs |
| --- | --- | --- |
| `network` | raw TCP to port 9100 | an IP |
| `system` | the OS spooler, by queue name | the agent running |
| `usb` | a raw device path (`USB001`, `/dev/usb/lp0`) | the agent running |
| `browser` | the browser's own print dialog | nothing |

Rows written before transports existed read as `network`, unchanged.

**Discovery.** The section leads with two buttons instead of an IP field:
«چاپگرهای ویندوز» reads the machine's installed queues (PowerShell `Get-Printer`
on Windows, `lpstat` on macOS/Linux) and «جست‌وجوی شبکه» sweeps the local /24
for an open 9100. Pairing is picking a row. Typing an address by hand is still
there for a printer on another subnet.

**Sheets vs rolls.** A thermal roll takes the raster path (screenshot → ESC/POS
`GS v 0`). A sheet on an installed queue is rendered to a real PDF
(`renderHtmlToPdf`, `preferCSSPageSize`) and spooled, because a laser driver
wants a page, not a bitmap.

## Printing without the agent

The section is fully usable with nothing installed: design, preview, and print
through the browser dialog (`printViaBrowser` — a hidden iframe, not a popup,
so nothing is blocked and focus stays in the POS). The agent's state is stated
plainly at the top of the section rather than discovered as a failed print at
the counter. A shop with a laser printer and a tablet may never install it.

## Testing

`src/lib/print-template.test.ts` renders every built-in and asserts on the
output string: Persian digits, Toman amounts, no Gregorian dates, escaped item
names, the ruled table's columns, two-copy pages on a sheet but never on a
roll, and that `starterTemplate` cannot alias the preset it copied.
`business-logo.test.ts` and `printer-input.test.ts` cover the two write
boundaries.

## Adding to the model

- **A new block type** — add it to `BlockType`/`BLOCK_LABELS`, render it in
  `renderBlock`, and add it to the designer's `ADDABLE` list. The parser picks
  it up from `BLOCK_LABELS` automatically.
- **A new paper** — one entry in `PAPERS`.
- **A new built-in template** — one entry in `BUILT_IN_TEMPLATES`; the gallery,
  the paper filter and the printer's template picker all read from it.
