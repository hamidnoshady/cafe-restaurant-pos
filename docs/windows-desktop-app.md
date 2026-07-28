# Running the POS like normal software on Windows (Phase 12)

This guide is for the person setting up the café laptop. The goal: after a
one-time setup, the staff just **double-click one icon** (or the app opens by
itself when the laptop turns on) — no Docker, no terminal, no technical steps.

There are two independent pieces and you can use either or both:

1. **The Windows launcher** — a single "Cafe POS" icon that starts everything
   behind the scenes and opens the app in its own window.
2. **PWA install** — installing the app itself so it lives in Windows like a
   real program, with its own window and Start-menu entry.

---

## Part 1 — One-time setup (done by whoever sets up the laptop)

You only do this once per laptop.

### Step 1: Install Docker Desktop (once)

Download and install Docker Desktop for Windows from
<https://www.docker.com/products/docker-desktop/>. During install, keep the
default options. After it finishes, open Docker Desktop once and, in its
Settings, turn on **"Start Docker Desktop when you log in"** so it's always
ready.

### Step 2: Put the app on the laptop and configure it

1. Copy this project folder onto the laptop (e.g. `C:\cafe-pos`).
2. In that folder, copy `.env.local.example` to `.env` and fill in:
   - `POSTGRES_PASSWORD` — any strong password.
   - `JWT_SECRET` — a long random secret (e.g. run `openssl rand -hex 32`).
   - `REMOTE_SYNC_TOKEN` — only if you're syncing with the VPS (see
     `docs/server-sync.md`).
3. Build the app once (this can take a few minutes):

   ```powershell
   docker compose -f docker-compose.local.yml up -d --build
   ```

   When it finishes, the POS is reachable at <http://localhost:3000>.

### Step 3: Run the installer (creates the icon + auto-launch)

From the project folder, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\Install-CafePOS.ps1
```

This creates:

- a **"Cafe POS" icon on the Desktop**,
- a **"Cafe POS" entry in the Start menu**, and
- an **auto-launch entry** so the POS opens automatically every time the
  laptop is turned on and the user logs in.

That's it. From now on the staff never need PowerShell or Docker.

Options:

- `-NoAutoLaunch` — create the icons but do **not** auto-start at login.
- `-Uninstall` — remove all three shortcuts (the app and its data stay).

> Icon note: the shortcut uses the coffee-cup icon (`windows/cafe-pos.ico`,
> checked into the repo) automatically — no extra tools needed.

---

## Part 2 — Daily use (the staff)

Nothing technical:

- **If auto-launch is on:** turn on the laptop, log in, wait a few seconds —
  the POS window opens by itself.
- **Any time:** double-click the **Cafe POS** icon on the Desktop.

The launcher quietly makes sure Docker is running, starts the POS, waits for
it to be ready, and opens it in its own clean window (no browser tabs or
address bar). The first launch after a reboot takes a little longer because
Docker has to wake up; later launches are quick.

To fully stop the POS (rarely needed), run `windows\Stop-CafePOS.bat`. Your
data is safe in Docker volumes; starting again restores everything. Normally
you can just close the window or shut the laptop down.

---

## Part 3 — Optional: install it as a PWA (its own real app window)

The POS is also a **Progressive Web App**, so you can install the app itself
into Windows. This gives you a dedicated app window and a Start-menu entry
that are separate from the browser.

1. Open <http://localhost:3000> in Microsoft Edge or Google Chrome.
2. Click the **install icon** in the address bar (a small monitor/►screen icon),
   or open the browser menu and choose **"Install Café POS…"** / **"Apps →
   Install this site as an app."**
3. Confirm. The app now appears in the Start menu and can be pinned to the
   taskbar like any program. Launching it opens a standalone window.

Once installed as a PWA, you can even point the launcher at the installed app
instead of a browser window — but the default `--app` window the launcher
opens already looks and behaves the same for staff, so this is optional.

> The service worker keeps the app window openable and shows a friendly
> Persian "connection lost" page if the server is momentarily unreachable
> (for example in the few seconds right after boot before Docker is fully up).
> It never caches orders, logins, or sync data — those always go to the live
> server so nothing is ever stale.

> If "Install" ever produces a window that still shows an address bar, the
> browser has fallen back to creating a plain shortcut instead of a true
> standalone install — this usually means it didn't consider the app
> installable. The manifest ships a full PNG icon set specifically so this
> check passes; the other common cause is a non-secure origin (see below).

> **Note:** true PWA install (and the service worker) requires a "secure
> context" — `https://` or `localhost`. `http://localhost:3000` on the café
> laptop itself qualifies, but other LAN devices reaching it at
> `http://<laptop-lan-ip>:3000` do not, so they'll always see a normal browser
> tab with an address bar and can't install the app, regardless of the
> manifest/icons. That's a browser security restriction, not a bug here.

---

## Troubleshooting

- **The window opens but shows "connection lost."** Docker was still starting.
  Wait ~30–60 seconds and reload; the launcher normally waits for this, but a
  cold boot can take longer.
- **Nothing happens when I double-click.** Make sure Docker Desktop is
  installed and set to start at login (Step 1). Run
  `windows\Start-CafePOS.bat` directly (double-click it) to see the messages.
- **I want to turn off auto-launch.** Re-run the installer with
  `-Uninstall`, then run it again with `-NoAutoLaunch`. Or just delete the
  "Cafe POS" shortcut from the Startup folder
  (`Win+R` → `shell:startup`).
- **LAN devices (phones, kitchen screen) can't connect.** They reach the
  laptop at `http://<laptop-lan-ip>:3000`, not `localhost`. Give the laptop a
  fixed LAN IP and use that address on the other devices. See
  `docs/server-sync.md`.
