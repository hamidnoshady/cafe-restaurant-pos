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
| `src/lib/print-agent-client.ts` | The browser's print client: local agent first, `/api/print/*` on the app server second, **and** the browser-dialog fallback. |
| `src/lib/system-print/**` | The shared printing machinery: discovery (Windows/CUPS queues + the LAN sweep), the spooler, Chromium rendering, and `service.ts` — one implementation used by both the agent and the app server. Server-only. |
| `src/app/api/print/**` | The app server's own print endpoints — the agent's twin, for deployments where the server can see the printers. |
| `print-agent/server.ts` | The full Node-based loopback agent, retained for development and managed installations. |
| `public/windows/cafe-pos-print-agent.ps1` | The dependency-free one-click Windows connector: queue discovery, exact-origin loopback HTTP, and native RAW spooler delivery. |
| `src/app/api/print/windows-agent-installer/route.ts` | Authenticated per-origin Windows installer download. |
| `src/app/(app)/settings/printing/**` | The section: gallery, designer, hardware, logo, and the connector install button. |

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
| `system` | the OS spooler, by queue name | the agent **or** the app server on the printer's machine |
| `usb` | a raw device path (`USB001`, `/dev/usb/lp0`) | the agent **or** the app server on the printer's machine |
| `webusb` | the browser itself, over WebUSB | Chrome/Edge on HTTPS, one pairing click |
| `browser` | the browser's own print dialog | nothing |

Rows written before transports existed read as `network`, unchanged.

**Two hardware backends, one fallback order.** Every hardware operation in
`print-agent-client.ts` tries the loopback print agent (`127.0.0.1:9123`)
first, and when it does not answer, the same operation against the app
server's `/api/print/*` twin routes. The server fallback sees only hardware
visible to the server process. That includes the standalone Electron install
(the server is a native Windows process) and printers configured on an
on-prem Linux/CUPS server. It does **not** include a Windows host's queues when
the app server is inside a Linux Docker container, and a cloud server can
never see the cashier PC's USB cable. Those two shapes need the local agent or
WebUSB. A *reachable* backend's error is final — it is never retried against
the other backend, because the two may be different machines.

**Discovery.** The section leads with two buttons instead of an IP field:
«چاپگرهای ویندوز» reads the installed queues (PowerShell `Get-Printer`
on Windows, `lpstat` on macOS/Linux) — from the till PC when the agent is
running, otherwise from the app server's machine, and the list says which —
and «جست‌وجوی شبکه» sweeps the local /24 for an open 9100. Pairing is picking
a row. Typing an address by hand is still there for a printer on another
subnet. A cloud deployment no longer describes a healthy server fallback as
proof that the cashier's Windows printers are available; the UI explicitly
asks for the local helper instead.

**Sheets vs rolls.** A thermal roll takes the raster path (screenshot → ESC/POS
`GS v 0`). A sheet on an installed queue is rendered to a real PDF
(`renderHtmlToPdf`, `preferCSSPageSize`) and spooled, because a laser driver
wants a page, not a bitmap.

**The browser as delivery middleman (`webusb`).** A *server* installation —
the app in a container or another building — can see neither the till's
Windows queues nor its USB cable, and the local agent may simply not be
installed. But the browser at the counter can: WebUSB gives a secure-context
Chromium page a direct pipe to a USB device the user paired once («اتصال USB
از مرورگر» in the printers tab). The job splits by who has what: the server
renders the ESC/POS bytes (`/api/print/render`, on the same
`system-print/service.ts` raster pipeline — Persian shaping needs a real
browser engine), and the page pushes them down the cable
(`src/lib/webusb-print.ts`). No print dialog anywhere, drawer kick included.
Limits stated in the UI: Chromium-only, HTTPS/localhost-only, raster papers
only (a sheet PDF has no meaning on a raw ESC/POS device), and on Windows a
printer whose vendor driver has claimed the interface refuses
`claimInterface` (`usb_claim_failed`) — install it as a plain USB device or
use `windows/usb-printer-bridge.js` instead.

## Windows-installed USB printers with a cloud server

A browser cannot enumerate or silently spool to Windows queues, so each cashier
PC that owns a Windows-installed printer needs the small local connector. The
operator installs it directly from «تنظیمات → چاپ و فاکتور → چاپگرها»: click
**«دانلود و نصب رابط چاپ ویندوز»**, open the downloaded file once, and accept
the Windows confirmation. There is no repository copy, Node.js, npm command,
PowerShell command, administrator account, or manual configuration. The
installer places the dependency-free connector in the current user's
`LocalAppData`, starts it immediately, and creates the current user's Windows
Startup shortcut so it runs after every login.

The authenticated download route (`/api/print/windows-agent-installer`) builds
the installer for the tenant origin serving the request. The installer fetches
`public/windows/cafe-pos-print-agent.ps1`; that connector is built only from
Windows PowerShell and .NET, listens only on `127.0.0.1:9123`, and accepts
browser requests only from the exact baked-in origin. It reads ordinary
unshared queues through `Win32_Printer` and submits RAW jobs by installed display
name through Windows' native `OpenPrinter` / `WritePrinter` API.

Rich Persian receipts still use the server's canonical renderer. The lightweight
connector answers `render_required`; `print-agent-client.ts` calls the
authenticated `/api/print/render`, Base64-encodes those ESC/POS bytes, and posts
them to the connector's `/print/raw` endpoint for local spooler delivery. A
claimed local job is never retried on the cloud server, avoiding both duplicate
prints and attempts to use a Windows queue name on Linux.

The cloud page must be HTTPS. Chrome/Edge 142+ asks once whether the site may
access the local network; allow it. In Chrome/Edge 145+ the loopback permission
is labelled **Apps on device** (older versions say **Local network access**).
If it was previously blocked, open the site's permissions from the icon beside
the address bar, change that permission to Allow, reload, and press «بررسی
dوباره». The CSP explicitly permits only the loopback agent origins; the
connector itself remains bound to `127.0.0.1` and is never exposed to the LAN.

## Printing without the agent

When the app server process can genuinely see the printers, hardware printing
works with no agent — the client falls back to `/api/print/*` automatically,
and receipts/invoices go straight to the paired printer with no browser
dialog. This is true for the native Electron install and configured server-side
CUPS queues, not for a cloud server or a Linux container trying to see its
Windows host. With neither backend able to reach the hardware, the section is
still fully usable: design, preview, and print through the browser dialog
(`printViaBrowser` — a hidden iframe, not a popup, so nothing is blocked and
focus stays in the POS). The printing state (agent / server / browser-only) is
stated plainly at the top of the section rather than discovered as a failed
print at the counter. A shop with a laser printer and a tablet may never
install anything.

**Chromium for rendering.** Both backends render with `playwright-core`
against an existing browser: `PRINT_AGENT_CHROMIUM_PATH` (or
`PDF_CHROMIUM_PATH`) if set, otherwise the machine's own Chrome/Edge/Chromium
is auto-detected (`src/lib/system-print/render.ts`) — on a Windows till, the
very browser the dashboard is open in.

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
