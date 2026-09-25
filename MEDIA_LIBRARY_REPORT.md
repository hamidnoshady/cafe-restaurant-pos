# Media Library — Session Report

**Branch:** `arena/01a0d95b-cafe-restaurant-pos`
**Base:** `81c29c4` (`main`)
**Scope of the originating request:** a complete, platform-wide, end-to-end Media
architecture rebuild (audit → schema → services → folders/collections/tags →
search/filters → upload/picker/lightbox → AI editing/generation → OCR/document
intelligence → migration of every app-specific media path → permissions → dead-code
removal → full test pyramid → CI → two audits → final report).

## A. Executive summary — read this first

**This is not the ground-up platform rebuild the original prompt describes**, and this
report does not claim it is. What shipped across this multi-session effort is a real,
test-covered, materially-more-consolidated Media Library than the one this branch
started from — with specific, named gaps that are listed honestly in Section V rather
than folded into vague "limitations" language.

What actually changed, in the order it was built:

1. **Bug-fix and consolidation pass** (first session, commit `6e37921`): fixed the named
   permission bug (cashier/waiter/kitchen images breaking), the pagination ceiling, added
   tenant-scoped SHA-256 duplicate detection, usage-aware safe delete, cycle-guarded
   folder moves, a wallet preflight in front of the paid AI enhance call, and rewrote the
   media manager and the universal picker around a shared debounce/cancel/pagination
   pattern.
2. **Phase 2 schema + features** (migration `0174`): trash/soft-delete with a retention
   purge tick, collections as a first-class concept distinct from folders and tags, and a
   `wordpress_media_mapping` table recording which canonical asset corresponds to which
   connection's remote WordPress attachment. All three are wired end-to-end at the
   service layer and (trash, collections) in the manager UI; the WordPress mapping table
   is real, tested, RLS-protected schema with tested service functions, but has **no
   route or UI consumer yet** — see Section K.
3. **Deterministic transforms** (migration `0175`, this session): crop/rotate/resize as a
   free, local, non-AI tier (`sharp`), producing new `transformed` derived assets with
   `source_asset_id` provenance and `transform_ops` history, wired into
   `POST /api/media/[id]/transform` and into the manager UI — rotate, resize, and (added
   later this session, see Section L) a drag-to-select crop rectangle over the drawer's
   preview image.
4. **Storage orphan reconciliation** (this session): `scripts/media-reconcile-orphans.ts`,
   a real, runnable, tested maintenance script — not a placeholder — that finds bucket
   objects no row claims (the two documented crash windows in
   `storeMediaAsset`/`deleteMediaAsset` that can produce one) and objects a row claims
   that no longer exist, without ever deleting a database row.
5. **MIME/byte-signature centralization audit** (this session): found and removed two
   real instances of duplicated byte-signature-check logic (`business-logo.ts`,
   `website/content-service.ts`) by delegating to the canonical
   `hasMatchingMediaSignature` in `src/lib/media.ts`; found and fixed one genuine,
   previously-unguarded trust-boundary gap — a CRM party's profile image had **zero**
   server-side format/signature validation before this session (client-side `file.type`
   checks only, trivially bypassable) — see Section O.2.

It did **not** touch: the canonical-asset-schema redesign beyond the additive columns in
`0174`/`0175`, a full naming-system rebuild, AI-tagging review-workflow states
(`pending_review`/`confirmed`/`rejected` semantics), a visual folder explorer with a
mobile drawer, rich filter-chip UI, a bounded-concurrency/retry/cancel upload manager, a
WordPress push route/UI built on top of the new mapping table, centralized
OCR/document-intelligence consumption by Accounting/CRM/Workspace, new AI editing
operations beyond crop/rotate/resize (background removal, upscale, variations), a new
numbered migration beyond `0174`/`0175`, dead-route removal, or E2E/mobile/accessibility/
performance tests/CI changes. Section V lists these as genuine open work.

Why the scope stopped where it did: the requested scope is a multi-week, multi-team
program. Given the choice between (a) shipping a shallow, unverified pass across the
entire list and calling it complete, or (b) shipping a narrower set of real,
deeply-verified fixes and stating the rest honestly as not done, this effort took (b) —
consistently, across every session — per the standing instruction that *"the final
report must be an honest accounting — not a claim of literal 100% completion if genuine
constraints prevented it."*

## B. Audit findings acted on (all sessions)

1. **Permission bug (the prompt's named bug):** `GET /api/media/[id]/file` unconditionally
   required `media.view`. Cashier/waiter/kitchen roles hold `menu.view`/`inventory.view`
   but not `media.view`, so a menu/inventory item's own photo failed to load for them.
   Fixed by making the route usage-aware (Section O.1).
2. **Pagination ceiling:** `GET /api/media` had no `limit`/`sort` exposed and the manager
   never advanced past page one — the library was effectively capped at ~60 rows.
3. **No duplicate detection:** every upload created a new row and object, even for
   byte-identical re-uploads in the same tenant.
4. **Unsafe delete:** assets referenced by a live menu/inventory item could be deleted,
   silently breaking their images app-wide.
5. **Unsafe folder move:** nothing guarded against moving a folder into its own
   descendant or itself.
6. **AI enhance had no wallet preflight:** the paid provider was called before checking
   the wallet could cover it.
7. **`detect` route dropped its own result:** AI label detection persisted but the
   response never returned the refreshed asset.
8. **Universal picker had no debounce/cancel/pagination** and could not detect
   duplicates, unlike the manager.
9. **No soft-delete tier:** every delete was a hard delete with no recovery window
   (fixed by `0174`'s trash).
10. **No grouping concept distinct from folders/tags:** the original audit's own
    "این‌ها همه برای کمپین تابستانه‌اند" example — an ad hoc cross-cutting set with no tree
    position — had no home (fixed by `0174`'s collections).
11. **No lightweight image editing at all:** the only image transformation in the whole
    codebase was the paid AI "enhance" call — no free crop/rotate/resize existed (fixed
    by `0175`'s deterministic transforms).
12. **No storage orphan detection:** `deleteMediaAsset` deletes the row **then**
    `s3Delete`s the object and explicitly swallows that second call's failure (by
    design, documented at its call site: "the row is gone... a stranded object costs
    storage, never data exposure") — meaning a transient S3 error already, silently,
    strands an object. `storeMediaAsset` similarly `s3Put`s **before** its `INSERT`, so a
    crash between those two lines strands an object with no row at all. Nothing found
    these. Fixed by `scripts/media-reconcile-orphans.ts`.
13. **Duplicated byte-signature logic:** the exact PNG/JPEG/WebP magic-byte checks were
    hand-copied into three files (`media.ts`, `business-logo.ts`,
    `website/content-service.ts`) — `media.ts`'s own comment already said "extends
    business-logo.ts's rule," acknowledging it. A future hardening change (e.g. closing
    an SVG vector) would have had to be applied three times by hand, or would silently
    diverge. Fixed by de-duplication (Section O.2 / this section, item 14).
14. **Missing server-side validation on a CRM field that reaches `<img src>`:** a party's
    `profileImage` was validated client-side only (`file.type`, spoofable) and had
    **zero** format or byte-signature check on the write path
    (`normalizePartyWrite` in `parties-service.ts` just did `textOf(...)`, no shape or
    signature check) despite the shared pure validator (`isProfileImageValue`) already
    existing in `src/lib/parties.ts` for the client form. A hand-crafted API request
    could store `profileImage: "javascript:alert(1)"` (harmless in a modern browser's
    `<img src>`, but the DB-level "this is a validated image" invariant was simply
    false) or a byte stream that does not match its claimed image type at all. Fixed —
    see Section O.2.

## C. Architecture

The canonical `media_assets`/`media_folders` schema from `migrations/0149` and
`0161_media_asset_provenance.sql` was extended, not redesigned, by two additive
migrations this program produced:

- **`0174_media_library_phase2.sql`** — `media_assets.deleted_at` (trash), two new
  tables (`media_collections`, `media_collection_items`), and a new table
  (`wordpress_media_mapping`). All three are additive: no existing column changed type,
  every new column is nullable or defaulted, and every list/read path was updated in the
  service layer to filter `deleted_at IS NULL` by default so nothing that existed before
  this migration silently changed meaning.
- **`0175_media_deterministic_transforms.sql`** — widens the `media_assets_variant_check`
  CHECK constraint (`original`/`enhanced` → `+ 'transformed'`) and adds
  `media_assets.transform_ops jsonb NOT NULL DEFAULT '[]'::jsonb`.

No table was dropped, renamed, or had a column's meaning changed. Every asset ID that
existed before this program still resolves to the same row with the same data.

## D. Database changes

Two new migration files, both applied and verified against a real local Postgres
(`npx tsx scripts/migrate.ts`, both forward-apply and the standard
`migrations.integration.test.ts` upgrade-from-a-stale-snapshot path):

| Migration | Adds |
|---|---|
| `0174_media_library_phase2.sql` | `media_assets.deleted_at`; `media_collections`; `media_collection_items`; `wordpress_media_mapping`; two partial indexes for trash/non-trash listing |
| `0175_media_deterministic_transforms.sql` | Widens `media_assets_variant_check` to include `'transformed'`; adds `media_assets.transform_ops jsonb NOT NULL DEFAULT '[]'` |

Both are RLS-protected with the standard `tenant_isolation` policy pattern
(`app_rls_bypass() OR business_id = app_current_business()`), `FORCE ROW LEVEL SECURITY`,
matching every other tenant-scoped table in the schema.

## E. Naming system

Not rebuilt as a formal system this program. The existing
`original_file_name`/`display_name`/`normalized_name`/safe-storage-key logic in
`src/lib/media.ts` is unchanged in shape; `normalizeSearchTerm` (search-time Arabic/
Persian character folding, added in the first session) is a related but distinct helper
— it never rewrites a stored name, only how a search term is matched against one.

## F. Folders

`PATCH /api/media/folders/[id]` accepts an optional `parentId` in addition to `name`, and
rejects a move with `circular_move` (self-parent or move-into-own-descendant) or
`too_deep` (exceeds the max-depth constant) before any row is written, backed by two
pure, unit-tested helpers: `folderDepthOf` and `folderMoveCreatesCycle` (including a
guard against infinite-looping on an already-corrupt cycle in the input data). No visual
tree explorer or mobile drawer was built — folders are still a flat picker list in the
manager UI.

## G. Collections — distinct from folders and tags

`migrations/0174` added `media_collections`/`media_collection_items`: a named, ad hoc,
renamable set an asset can belong to any number of (or none), with no tree position of
its own — deliberately distinct from a folder (a tree position an asset holds exactly
one of) and from a tag (a free-text label with no first-class identity). Full CRUD is
wired: `GET/POST /api/media/collections`, `PATCH/DELETE /api/media/collections/[id]`,
`POST/DELETE /api/media/collections/[id]/items[/[assetId]]`, `GET /api/media/[id]/collections`
(which collections one asset belongs to). The manager UI lets an operator filter the
library by collection, create/rename/delete a collection, and add/remove the current
selection to/from one via the bulk-action bar. Membership counts follow non-trashed
assets only (verified by an integration test). Tenant-scoped uniqueness on
`(business_id, name)` means two businesses can each have their own "کمپین تابستانه"
without collision.

## H. Tags / auto-tagging

Not rebuilt. The `detect` route now correctly returns its own persisted result (bug 7
above), but the `pending_review`/`confirmed`/`rejected` review-workflow semantics called
for in the original request were never implemented — no such column exists, and tags are
still applied directly by the AI detection call with no human-review gate.

## I. Search / filters / sort

`GET /api/media` supports `sort` (`MEDIA_SORTS`/`mediaSortOrderBy`), `source`
(`upload`/`ai_attachment`/`ai_generated`), `trashed`, and `collectionId`, all validated
server-side against literal allow-lists. Search-term handling is centralized in
`normalizeSearchTerm` (trim/collapse whitespace/cap at 120 chars/fold Arabic ي‌ك to
Persian ی‌ک) and `mediaSearchExpression` (the matching `translate(...)` SQL wrapper, so
the folding is consistent at the database level, not just in application code). No rich
filter-chip UI was built; filtering is still a set of dropdowns/toggles in the manager,
not removable chips.

## J. Upload

`POST /api/media` computes a SHA-256 of the uploaded bytes and looks up
`findMediaAssetByHash` scoped to the caller's tenant before creating a new asset; a match
returns the existing asset with `duplicate: true` and HTTP 200 (an `allowDuplicate` form
field forces a genuine second copy). Both the manager and the universal picker surface
this with a Persian toast. **No bounded-concurrency/retry/cancel upload manager was
built** — uploads remain one-at-a-time, sequential, with no client-side retry on a
transient failure and no cancel-in-flight affordance. This is the single largest
concretely-scoped piece of the original request that was never attempted.

## K. WordPress

`migrations/0174` added `wordpress_media_mapping` (canonical asset ↔ one connection's
remote attachment, unique per `(connection_id, media_asset_id)` so a re-push updates the
existing row rather than duplicating it on the WordPress side) and four service functions
(`recordWordPressMediaPush`, `confirmWordPressMediaSync`, `failWordPressMediaSync`,
`getWordPressMediaMapping`/`listWordPressMappingsForAsset`), all covered by integration
tests against a real database (pending push → confirmed sync; re-push updates in place;
failed push recorded distinctly from synced).

**This is schema and service-layer plumbing with no consumer.** `grep`-confirmed: no
route and no UI component calls any of these four functions. `src/app/(app)/websites/wp/`
and `src/app/api/integrations/wp-manager/media/` — the actual WordPress media mirror a
user interacts with today — are unchanged; they still run their own independent mirror,
not a view over the canonical Media Library. Turning WordPress media into "a view over
central Media" (the original request's exact phrase) needs: a route that lets an
operator push a canonical asset out to a connected WordPress site (calling
`recordWordPressMediaPush`, then an outbox job that actually uploads bytes via the
WordPress REST API and calls `confirmWordPressMediaSync` on the plugin's webhook
confirmation), and a UI affordance in the wp-manager screens showing "already pushed to
this site" using the mapping table instead of (or alongside) the existing independent
mirror. None of that exists yet.

## L. AI media (editing / generation)

- **AI-provider operations** (`enhance`): unchanged this session beyond the earlier
  wallet-preflight and `detect`-response fixes. No background removal, upscale, or
  variations operation was added.
- **Deterministic (non-AI) operations** — new this session, migration `0175`:
  `POST /api/media/[id]/transform` accepts `{operation: "crop"|"rotate"|"resize", ...}`,
  validated by `parseMediaTransformInput` (crop: integer x/y/width/height, 1..4000px;
  rotate: finite non-zero degrees, ±360; resize: at least one of width/height, 1..4000px,
  `fit` ∈ cover/contain/inside/fill, default `inside`), executed by
  `applyMediaTransform` (`sharp`, always emits PNG bytes, throws `MediaTransformError`
  with a `code` the route maps to 422/400/500), and stored as a new `variant:
  "transformed"` asset with `source_asset_id` pointing at the original (which is never
  modified) and `transform_ops` recording exactly which operation produced it — the
  same non-destructive parent/child shape as `enhance`. No wallet cost: this is local
  CPU work, not a provider call, and the route does not touch the wallet at all.
  **UI reach**: the manager's asset drawer has a "چرخش ۹۰° راست/چپ" (rotate) pair of
  buttons, a width field with "تغییر اندازه به این عرض" (resize), and — added later this
  session — "برش تصویر" (crop): a drag-to-select rectangle drawn with native Pointer
  Events directly over the drawer's preview `<img>`, converted from displayed CSS-pixel
  coordinates to the image's `naturalWidth`/`naturalHeight` (the exact space
  `applyMediaTransform`'s `sharp(...).rotate()` auto-orient measures server-side, so the
  mapping is exact rather than approximate) before calling `transform("crop", ...)`; a
  minimum drag size (12 CSS px) keeps an accidental click from arming "اعمال برش", and
  "انصراف" discards the rectangle without a request. Covered by
  `src/app/dashboard/media/media-manager.test.tsx` (button hidden for non-image assets,
  sub-minimum drag stays disabled, a real drag produces the exact expected natural-pixel
  request body, cancel never calls the API). There is still no version-history UI showing
  a transformed asset's lineage back to its source beyond what the asset drawer's
  existing "usage" panel exposes incidentally.
- **AI generation**: unchanged — `ai_generated` provenance already existed before this
  program and is unaffected.

## M. OCR / document intelligence

Not touched. `ai-invoice-ocr*`, `ai-receipt.ts`, `ai-inventory-vision*` are exactly as
they were. `ai-receipt.ts`'s own header comment documents a deliberate, narrower design
(the receipt image is a client-supplied data URL used for exactly one AI provider call
and is never written to any table or object storage) — this was read and left alone as
an intentional exception, not a bug, because centralizing it into the Media Library would
mean persisting every receipt photo a cashier ever snaps for a one-shot OCR read, a
storage/retention policy question the original design explicitly opted out of and this
session did not have the standing to reverse. No Accounting/CRM/Workspace consumption of
a centralized OCR pipeline exists, because no centralized OCR pipeline was built.

## N. Per-app migration status

| App | Uses canonical Media Library? |
|---|---|
| Menu items (`menu-manager.tsx`) | **Yes** — `MediaImageField`/`MediaPickerDialog`; benefits from the permission fix (B.1) |
| Inventory items (`items-section.tsx`) | **Yes** — same components, same permission-fix benefit |
| Product | No separate module — "Product" in this app's dashboard is a view over menu/inventory items, both already covered above |
| AI Chat attachments | **Yes** (pre-existing) — `source='ai_attachment'` via `ai-media-persist.ts` → `storeMediaAsset` |
| AI-generated images | **Yes** (pre-existing) — `source='ai_generated'` |
| WordPress/CMS media mirror | **No** — independent mirror; a mapping table exists with no consumer (Section K) |
| Website builder (`website/content-service.ts`, distinct first-party CMS, not WordPress) | **No** — pushes bytes to an external headless-CMS adapter by design (not this app's own storage); its byte-signature check now delegates to the canonical one (Section O.2), but its upload target is genuinely external, not a duplicate of local storage |
| Accounting (invoice/receipt OCR) | **No** — deliberately ephemeral, not persisted anywhere (Section M) |
| CRM (party profile image) | **No** — inline `data:` URL on the party row, same architecture as the business logo (not S3-backed); this session added the server-side validation it was missing (Section O.2) but did not migrate it onto the Media Library |
| Workspace | Not audited this session |

## O. Permissions & security

### O.1 The named permission bug

`GET /api/media/[id]/file` now authorizes by **asset usage**, not unconditionally by
`media.view`:
- Document-kind assets still always require `media.view` (unchanged, conservative).
- Image/video assets are servable if the caller has `media.view`, **or** has
  `menu.view` and the asset is a menu item's `image_media_id`, **or** has
  `inventory.view` and the asset is an inventory item's `image_media_id` — checked per
  request against the database, not by role name.

This does not weaken tenant isolation: the usage lookup is itself tenant-scoped by RLS,
and a caller must still separately hold the relevant `*.view` permission.
`src/app/api/api-guards.test.ts`'s general "every `requireMember`-guarded route scopes
its work to `session.sub`" invariant does not describe this route (it is "every member
reaches the gate; the real decision is a per-request usage/permission check"), so it was
added to that test's existing, documented exemption list with a comment explaining why,
rather than weakened.

### O.2 This session's security fixes (found during the MIME/byte-signature audit)

1. **De-duplicated byte-signature logic.** `hasMatchingMediaSignature`
   (`src/lib/media.ts`) is the canonical check; `business-logo.ts`'s
   `hasMatchingLogoSignature` now delegates to it entirely (its four MIME types are an
   exact subset), and `website/content-service.ts`'s `hasMatchingImageSignature`
   delegates to it for jpeg/png/webp and keeps only its own genuine extension (gif,
   which the Media Library does not accept). Both files' existing unit tests pass
   unchanged, proving the delegation is behavior-preserving. One ruleset, not three.
2. **Closed a real server-side validation gap.** A CRM party's `profileImage` — later
   rendered as `<img src>` in the party form — had a shared pure validator
   (`isProfileImageValue` in `src/lib/parties.ts`) that was called **only** from the
   client-side form (`validatePartyForm`), never from the server write path
   (`normalizePartyWrite` in `parties-service.ts`, which just did `textOf(...)` with no
   shape check at all). Fixed: `normalizePartyWrite` now calls a new
   `validatedProfileImage` helper that (a) runs the existing shape check and (b), for a
   `data:` URL specifically, decodes the base64 and runs it through
   `hasMatchingMediaSignature` — so a value claiming `image/png` whose bytes are not a
   PNG is now rejected with `PartyValidationError("invalid_image", "profileImage")` on
   **both** create and update, at the one place all party writes go through (confirmed
   by `grep` — no other file writes `parties.profile_image`). An `https://` linked
   avatar has no bytes to check and is accepted as before. Verified with 5 new
   integration tests against a real database (valid PNG accepted, valid https link
   accepted, a fake PNG rejected on create, a non-image string rejected, a fake JPEG
   rejected on update).

No security control was removed or weakened anywhere in this program; every change in
this section either added a check that did not exist or moved an existing check to a
single shared implementation.

## P. Storage / orphan handling

`scripts/media-reconcile-orphans.ts` (new, this session; `npm run media:reconcile-orphans`)
is a real, runnable, tested maintenance script:

- **Dry run by default.** Lists every object under the platform's configured bucket
  prefix (`s3List`, already existed for backups), loads every `media_assets.storage_key`
  (trashed rows included — a trashed asset still legitimately owns its object until the
  retention purge), and reports (a) orphaned objects — no row claims them, and they are
  older than a one-hour grace period (so a concurrent in-flight upload's object is never
  mistaken for an orphan), (b) malformed keys (never auto-deleted, flagged for manual
  review), and (c) broken references — a row whose `storage_key` resolves to nothing in
  the bucket, which the script only ever reports, never acts on, because deleting that
  row is a data-loss decision a maintenance script should not make unattended.
- **`--apply --backup-confirmed`** (both required, mirroring the existing
  `reconcile-opening-inventory.ts` convention) deletes exactly the safely-shaped orphaned
  objects and nothing else — never a database row.
- **Verified against a real database and a real in-memory S3-compatible mock** (not a
  hand-wave): 6 new integration tests in
  `integration/media-reconcile-orphans.integration.test.ts`, invoking the script as an
  actual child process the way an operator or a cron job would, covering: storage not
  configured, dry-run detection with the grace period respected, `--apply` refused
  without `--backup-confirmed` (deletes nothing), `--apply --backup-confirmed` deletes
  exactly the orphan and leaves the claimed object alone, a broken reference is reported
  without touching the row, and a trashed asset's object is correctly treated as claimed.
  All 6 passed on the first real run against the mock bucket.
- **Note on a pre-existing, unrelated repo issue found while building this**: the
  existing `scripts/reconcile-opening-inventory.ts` uses top-level `await`, which fails
  outright when run via `npx tsx` in this environment (`Top-level await is currently not
  supported with the "cjs" output format` — confirmed by actually running it, not by
  inspection) because the root `package.json` declares `"type": "commonjs"`. This is a
  latent, real bug in an unrelated inventory script, discovered as a side effect of this
  work; it was **not** fixed (out of scope for a Media session, and changing the root
  module type is a repo-wide decision this session should not make unilaterally). The
  new `media-reconcile-orphans.ts` avoids the same trap by wrapping its body in an
  `async function main()` instead of top-level `await`, so it actually runs.

Beyond this script, there is still no trash-*independent* orphan sweep triggered
automatically (it is a manually-run maintenance script, not a scheduled tick) — the
scheduled tick that does exist (`runMediaTrashPurgeTick`, wired into `server.ts` on the
same hourly cadence as the billing tick) purges expired trash rows, which is a different
concern (soft-deleted rows past retention) from orphaned bucket objects with no row at
all.

## Q. Route changes (cumulative, all sessions)

| Route | Change |
|---|---|
| `GET /api/media` | + `sort`, `limit`, `source`, `trashed`, `collectionId` query params |
| `POST /api/media` | + tenant-scoped SHA-256 dedup, `allowDuplicate` override, 200-vs-201 split |
| `DELETE /api/media/[id]` | now a soft delete (trash) by default; usage check; `?force=1` override; 409 `asset_in_use` with usage payload |
| `POST /api/media/[id]/restore` **(new)** | restores a trashed asset |
| `POST /api/media/[id]/detect` | response now includes the refreshed `asset` |
| `POST /api/media/[id]/enhance` | + wallet balance preflight → 402 `insufficient_funds` |
| `POST /api/media/[id]/transform` **(new)** | deterministic crop/rotate/resize; no wallet cost |
| `GET/POST /api/media/[id]/collections` **(new)** | which collections an asset belongs to; add to one |
| `GET/POST /api/media/collections` **(new)** | list/create collections |
| `PATCH/DELETE /api/media/collections/[id]` **(new)** | rename/delete a collection |
| `POST/DELETE /api/media/collections/[id]/items[/[assetId]]` **(new)** | add/remove membership |
| `PATCH /api/media/folders/[id]` | + `parentId` (folder move), cycle/depth guards |
| `GET /api/media/[id]/file` | permission model changed from unconditional `media.view` to usage-based (Section O.1) |
| `GET /api/media/[id]/usage` **(new, first session)** | asset usage references for the delete-confirmation UI |

No routes were removed.

## R. Dead code / route removal

**None removed.** No dead-code audit pass targeting route/component removal was
performed; everything found during the MIME-centralization audit (Section O.2) was a
duplication to consolidate, not dead code to delete.

## S. Bugs fixed (cumulative — see Sections B and O.2 for detail)

1. Cashier/waiter/kitchen image-permission bug (the prompt's named bug).
2. Media list pagination ceiling / missing sort & source filters.
3. No duplicate detection on upload.
4. Unsafe delete of in-use assets (now further superseded by trash as the default).
5. Unsafe folder move (no cycle/self-parent/depth guard existed at all).
6. AI enhance spent before checking wallet balance.
7. `detect` route silently dropped its own result from the response.
8. Universal picker had no debounce/cancel/pagination and could not detect duplicates.
9. Storage orphans from the two documented crash windows in
   `storeMediaAsset`/`deleteMediaAsset` had no detection or cleanup mechanism at all.
10. Byte-signature-check logic was hand-duplicated in three files with no single source
    of truth.
11. A CRM party's profile image had no server-side format/signature validation at all —
    the only real bug fixed this session with a genuine (if narrow) security dimension.

## T. Tests added / changed (cumulative)

- `src/lib/media.test.ts`: 34 tests total (was 19 before this program) — sort/search
  normalization/folder-cycle helpers (first session) + 5 new this session for
  `parseMediaTransformInput` (crop/rotate/resize valid & invalid shapes, the
  `fit: "inside"` default, unknown-operation and non-object-body rejection).
- `src/lib/media-transform.test.ts` **(new file, this session)**: 6 tests against real
  synthetic PNGs generated with `sharp` — crop dimensions, crop out-of-bounds rejection,
  rotate 90° dimension swap, resize `fit: "inside"` bound check, resize `fit: "fill"`
  exact dimensions, non-image bytes rejected via `MediaTransformError`.
- `integration/media-library.integration.test.ts`: 40 tests total — the first session's
  +5 `describe` blocks (dedup, sort, source filter, search normalization, usage
  references), the phase-2 work's trash/collections/WordPress-mapping blocks, and 3 new
  tests this session for the deterministic-transform feature (a `transformed` asset's
  round-trip through `getMediaAsset` including `sourceAssetId`/`transformOps`; a
  crop-then-resize chain recording only its own op at each step, not accumulated
  history; a transformed asset appearing in a filtered library listing next to its
  source).
- `integration/media-reconcile-orphans.integration.test.ts` **(new file, this session)**:
  6 tests, described in Section P.
- `integration/parties.integration.test.ts`: +5 tests this session for the
  `profileImage` server-side validation fix (Section O.2) — valid PNG accepted, valid
  https link accepted, fake PNG rejected on create, non-image string rejected, fake JPEG
  rejected on update.
- `src/app/api/api-guards.test.ts`: +1 documented exemption entry (the `media/[id]/file`
  usage-based-permission route, Section O.1) — a test-suite correction, not new coverage.
- `src/app/dashboard/media/media-manager.test.tsx` **(new file, this session, jsdom +
  Testing Library, following the same `@vitest-environment jsdom` / real-Pointer-Event
  pattern as `hold-repeat-button.test.tsx`)**: 3 tests against the drawer's new crop UI —
  the "برش تصویر" button is absent for non-image assets; a drag under the 12px minimum
  leaves "اعمال برش" disabled while a real drag arms it and produces the exact expected
  natural-pixel `{operation:"crop", params:{x,y,width,height}}` body against a stubbed
  2×-downscaled image geometry; "انصراف" discards the rectangle and never calls the
  transform endpoint. `AssetDrawer` and `AssetRow` were exported from `media-manager.tsx`
  (previously module-local) solely so this test can render the drawer in isolation
  without mounting the full library page and its data-fetching grid.

No tests were skipped, stubbed, or marked as TODO anywhere in this program. This is now
one dedicated Media *component* test (the crop interaction above) — a first, narrow
instance of the RTL-component layer of the requested test pyramid for Media, not the
full breadth of it. No E2E, mobile, or accessibility tests were added for Media; the
repo's existing generic design/RTL/dark-mode lint suites, which run against every
dashboard page including the media manager, were re-run and pass, but that remains
distinct from dedicated Media E2E/mobile/a11y coverage.

## U. Verification results (commands actually run this session, in order)

1. `npx tsc --noEmit -p tsconfig.json` → clean, run after every substantive change in
   this session (media-service wiring, the transform route, `media-transform.ts`'s
   `sharp.Sharp` → `Sharp` type fix, the orphan script, the MIME delegation, the parties
   fix) — always re-run to green before moving on, never left red between steps.
2. `npx eslint <touched files>` → clean after every substantive change; `npx eslint
   scripts/media-reconcile-orphans.ts`, `src/lib/parties-service.ts`,
   `src/lib/business-logo.ts`, `src/lib/website/content-service.ts`,
   `integration/*.test.ts` → all clean, `--max-warnings=0`.
3. `npx vitest run src/lib/media.test.ts src/lib/media-transform.test.ts` → 40/40 passed.
4. `npx vitest run src/lib/business-logo.test.ts src/lib/website/content-service.test.ts`
   → 9/9 passed (proves the byte-signature delegation is behavior-preserving).
5. `npx vitest run src/lib/parties*.test.ts src/app/dashboard/parties/*.test.ts` →
   129/129 passed (no regression from the `profileImage` validation change).
6. `npx vitest run` (full unit suite) → **425/425 files passed, 5979/5979 tests
   passed**, run twice this session (once mid-session, once as the final check after
   every change below was in place) — both green.
7. `DATABASE_URL=... npx vitest run --config vitest.db.config.ts` (**full** DB
   integration suite, all files) → run three times this session as changes accumulated:
   132/132 files, 1536/1537 (first run, before this session's new tests existed) →
   132/132, 1539/1540 (after the transform-feature integration tests were added) →
   **133/133 files, 1550/1551 tests passed, 0 failed** (final run, after the
   orphan-reconciliation script, the MIME-signature delegation, and the parties
   `profileImage` fix were all in place — the file count rose from 132 to 133 because
   `media-reconcile-orphans.integration.test.ts` is a new file). Every individual new
   test file (`media-library`, `media-reconcile-orphans`, `parties`) was also run
   standalone and passed cleanly before this final full run. The 1 skipped test
   throughout is pre-existing and unrelated to Media.
8. `npx tsx scripts/media-reconcile-orphans.ts` (against the local dev database, storage
   not configured) → correctly printed "nothing to reconcile" and exited 0, proving the
   script is actually runnable, not just type-checked.
9. `npx tsc --noEmit` / `npx eslint .` (whole repo, prior sessions and re-confirmed at
   the very end of this session) → clean.
10. `npm run build` — **attempted 4 times this session, all 4 killed by the sandbox's
    OOM killer** (`dmesg` confirms a real `oom-kill`, not a code error: the build
    process's anon-rss reached ~3.3 GB against this container's ~3.8 GB total before
    being killed). This is a change from an earlier session in this same program, which
    reports this exact command succeeding once, before the codebase grew further.
    Diagnosed, not just retried blindly: (a) tried `--max-old-space-size` at 3200 and
    2600 — same outcome both times, so the ceiling is not the V8 heap setting; (b)
    added `sharp` to `serverExternalPackages` (a legitimate, kept improvement — native
    addons should never be webpack-bundled — see the diff in `next.config.ts`) in case
    tracing its native bindings was the spike — no change; (c) as a pure diagnostic,
    temporarily set `typescript.ignoreBuildErrors`/`eslint.ignoreDuringBuilds` to `true`
    to isolate whether the duplicate type-check/lint pass inside `next build` was the
    cause — still OOM-killed, so it is the webpack compilation of this app's ~440
    routes itself that no longer fits in this sandbox's memory ceiling; **this
    diagnostic change was reverted immediately** and is not part of the shipped diff.
    `npx tsc --noEmit` (which performs the same type-check `next build` would) is clean,
    and every route file touched this session (`transform`, `collections`, `restore`,
    `usage`, etc.) passed `eslint` individually — this is a sandbox resource ceiling,
    not a code defect, but it is a real gap in this session's own verification chain and
    is reported as such rather than assumed away.
11. **Follow-up session — crop UI**: closed the "crop is implemented but has no click
    target" gap noted in Section L/V of the prior report. `npx tsc --noEmit` clean;
    `npx eslint src/app/dashboard/media/media-manager.tsx
    src/app/dashboard/media/media-manager.test.tsx --max-warnings=0` clean; the new
    `media-manager.test.tsx` (3 tests) passes standalone and inside the full unit run;
    the full unit suite was re-run afterward — **426/426 files, 5982/5982 tests
    passed** (the file/test counts rose by 1 file / 3 tests from the previous report's
    425/5979 — consistent with only the new crop test file being added, 0 regressions
    elsewhere); both Media integration suites
    (`media-library.integration.test.ts` 40/40, `media-reconcile-orphans.integration.test.ts`
    6/6) were re-run against a freshly re-initialized local dev database (this sandbox
    does not persist `node_modules` or the Postgres data directory across sessions —
    `npm ci` and the numbered migrations in `migrations/` were re-applied from scratch,
    all 216 including `0174`/`0175` applying cleanly) and passed.

Net effect on the test suite across this whole program: **+24 unit tests
(`media.test.ts` 19→34, `media-transform.test.ts` 0→6, `media-manager.test.tsx` 0→3),
+14 integration tests from the prior session (3 transform + 6 orphan-reconciliation + 5
parties), plus the phase-2 trash/collections/WordPress-mapping integration coverage from
the middle of this program — 0 net regressions** at every checkpoint where the full
suite was re-run.

## V. Second audit / genuine remaining work

A dead-code removal pass was never performed (Section R), so there is no
"re-run tests after cleanup" step to report beyond what Section U already shows: every
full-suite re-run this session, after every change, was green.

**Before closing, an honest list of what remains — not "limitations," open scope:**

- **Central uploader** with bounded concurrency, retry, and cancel — uploads are still
  one at a time with no retry or cancel affordance (Section J). This is the largest
  single piece of concretely-scoped, named work never attempted.
- **WordPress as "a view over central Media"** — the mapping table and its service
  functions exist and are tested, but nothing pushes a canonical asset to a connected
  WordPress site through them yet, and the existing independent WordPress media mirror
  is untouched (Section K).
- ~~**Crop has no UI entry point**~~ — closed in a follow-up session: a drag-to-select
  crop rectangle is now wired into the manager's asset drawer, tested, and verified
  (Section L, Section U item 11).
- **AI tag review-workflow states** (`pending_review`/`confirmed`/`rejected`) — never
  implemented; tags apply directly with no human gate (Section H).
- **Visual folder explorer / mobile drawer, rich filter-chip UI** — the manager still
  uses flat dropdown/list controls, not the tree-explorer/chip UI the original request
  described (Sections F, I).
- **New AI editing operations** beyond crop/rotate/resize — no background removal,
  upscale, or variations operation exists.
- **Centralized OCR/document intelligence** for Accounting/CRM/Workspace — not built;
  `ai-receipt.ts` remains a deliberately ephemeral, single-purpose helper by its own
  documented design (Section M).
- **CRM party avatars and the website builder's own media** are still independent of the
  canonical Media Library's S3-backed storage (by different, individually-documented
  reasons in each case — Section N) — not migrated onto `MediaImageField`/
  `MediaPickerDialog`, only hardened where a genuine security gap was found (Section
  O.2).
- **Workspace** files were not audited this session at all.
- **E2E, mobile, and accessibility test coverage specific to Media** — never attempted;
  only the repo's pre-existing generic design-lint/RTL/dark-mode suites (which happen to
  cover every dashboard page, including media) were re-run.
- **CI configuration** — untouched; no new CI job or gate was added for any of this
  program's new tests (they run under the same `npm test`/`npm run test:db` commands CI
  already invokes, but no new named CI step highlights them specifically).
- **`npm run build` could not be completed in this sandbox this session** — it was
  attempted 4 times and OOM-killed every time (confirmed by `dmesg`, not inferred), even
  after lowering the heap limit, externalizing `sharp`, and (as a reverted diagnostic
  only) disabling the build's internal type-check/lint pass. `tsc --noEmit` and `eslint`
  are both clean against the exact same code, which is the strongest available signal
  short of an actual production bundle, but a completed `next build` is a genuinely
  unverified step this session, named here rather than assumed to still pass because it
  once did earlier in this program.
- **A pre-existing, unrelated bug was found and left unfixed on purpose**:
  `scripts/reconcile-opening-inventory.ts` cannot actually run via `npx tsx` in this
  environment (top-level `await` vs. the repo's `"type": "commonjs"`) — out of scope
  for a Media-focused session, noted in Section P instead of silently ignored.

These are exactly the parts of the original request this program did not reach, or
reached only partially. Nothing above is hidden in vaguer language than this.
