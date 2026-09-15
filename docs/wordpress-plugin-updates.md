# WordPress plugin updates — the self-updater and the release runbook

The WooCommerce plugin (`wordpress-plugin/pos-accounting-connector/`) is not in the
WordPress.org directory and never will be: its source of truth is this repository.
Since 1.4.0 it carries its own update system (`includes/class-pos-updater.php`), so a
store owner updates it exactly like a directory plugin — from **«افزونه‌ها ←
به‌روزرسانی‌های موجود»**, **«پیشخوان ← به‌روزرسانی‌ها»**, WordPress auto-updates, or
`wp plugin update pos-accounting-connector` — with GitHub releases and tags standing
in for the directory API.

## What a store sees

- WordPress's normal twice-daily update cycle checks GitHub (cached six hours per
  store; a failed check retries after fifteen minutes and never erases the last good
  answer — an update nag that was already showing survives a GitHub hiccup).
- A new release shows on the Plugins screen with the standard
  «مشاهدهٔ جزئیات نسخهٔ …» modal (description + the release notes) and one-click
  install. Auto-update toggles and `wp plugin update` work, because the update rides
  the same `update_plugins` transient every other plugin does.
- The plugin's own settings screen («ووکامرس ← اتصال حسابداری») shows the installed
  version, the newest found version, the last check time, and a
  «بررسی به‌روزرسانی» button — the one user-initiated GitHub call. `wp pos-connector
  check-update` is its WP-CLI twin, and `wp pos-connector status` prints the cached
  answer.
- The updater initializes **before** the WooCommerce gate, so the plugin can still
  update itself on a store where WooCommerce is deactivated or missing.

## How it works

`POS_Connector_Updater` hooks the three standard third-party update points:

| Hook | What it does here |
| --- | --- |
| `pre_set_site_transient_update_plugins` | Puts a newer release into the `update_plugins` transient (`response`) as a `package` pointing at the GitHub zip; marks the plugin `no_update` when current. |
| `plugins_api` | Answers the «مشاهدهٔ جزئیات» modal (release notes as the changelog section). |
| `upgrader_source_selection` | Makes a GitHub zip installable (see below). |

Plus `upgrader_process_complete` (drops the cache, writes the «به‌روز شد» log line)
and an `admin_post_` handler for the manual check button, following the screen's
existing nonce/notice pattern.

**Package selection**, in order:

1. The release asset named `pos-accounting-connector.zip` (built by
   `wordpress-plugin/package-release.sh`) — extracts to the right folder, installs
   as-is.
2. Any other `.zip` release asset.
3. The tag's **zipball** — the whole repository. `fix_source_dir()` re-points the
   installer at the `wordpress-plugin/pos-accounting-connector/` subfolder inside it
   before WordPress copies it over the installed plugin; the rest of the extracted
   tree is deleted by the upgrader's own working-directory cleanup.

**Version rules:** a tag `v1.4.0` means version `1.4.0`. Anything that does not parse
as `X.Y.Z(-suffix)` is refused rather than guessed. An update is offered only when
`version_compare()` says the found version is newer.

**Security:** the `package` URL is rebuilt locally and constrained to this
repository's tags and assets on GitHub's own download hosts (`github.com`,
`codeload.github.com`, `objects.githubusercontent.com`, `api.github.com`) before
WordPress is allowed to download and run it. Release notes shown in the modal pass
through `wp_kses_post`.

**Costs:** unauthenticated GitHub API, two calls per store per day — nowhere near
the 60/hour-per-IP limit. Private forks can point the updater at themselves
(`pos_connector_update_repo` filter) and add `Authorization` headers
(`pos_connector_updater_headers` filter) without forking the class.

## Release runbook

1. Bump the version in **three places** (repo rule, see CLAUDE.md): the `Version:`
   header and `POS_CONNECTOR_VERSION` in `pos-accounting-connector.php`, and the
   `Stable tag` in `readme.txt`. Write the `readme.txt` changelog entry.
2. Merge to `main`, then tag the release:

   ```bash
   git tag -a v1.4.0 -m "POS Accounting Connector 1.4.0"
   git push origin v1.4.0
   ```

3. Build the zip asset and attach it to a GitHub release for that tag
   (gh CLI shown; the web UI works too):

   ```bash
   cd wordpress-plugin
   ./package-release.sh
   gh release create v1.4.0 pos-accounting-connector.zip \
     --title "POS Accounting Connector 1.4.0" \
     --notes-file changelog-entry.md
   ```

   The release notes you write here are what the plugin's details modal shows, so
   paste the changelog entry.

4. Done. Stores pick it up on their next update cycle (or immediately via
   «بررسی دوباره» / the plugin's own «بررسی به‌روزرسانی» button).

**A bare tag with no release works too** — the updater falls back to the tag's
zipball — but the asset path is the good one: a ~50 KB zip instead of the whole
repository, and no source-directory fixing. When a release exists, its asset wins.

### Rules that keep it working

- Tag names must start with `v` + a plain version (`v1.4.0`, `v1.4.1`).
- The plugin folder name stays `pos-accounting-connector` — it is the slug WordPress
  indexes updates by and what `wp plugin update pos-accounting-connector` expects.
- The `Update URI:` header in the main plugin file must stay a non-WordPress.org
  URI: it tells core never to ask the directory about this plugin (so a same-slug
  directory plugin can never shadow ours).
