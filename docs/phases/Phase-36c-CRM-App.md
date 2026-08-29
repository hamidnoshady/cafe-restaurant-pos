# Phase 36c — the CRM app («ارتباط با مشتری»)

> Filed as **36c** because it is the third app in the ecosystem Phase 36 wave 1
> (#359) set up, after 36b's Growth app. It implements GitHub issue **#367**,
> and **deliberately departs from it in two ways** — both recorded under
> "Departures from #367" below, because a later reader comparing the issue to
> the code should find the disagreement stated rather than have to guess.

## Why

The customer record was the most-referenced entity in the product and the
least-served. `customers` was touched by orders, loyalty, AR receipts,
reservations, repairs, WooCommerce sync and the assistant — and the only screen
that owned it was a flat table at `/dashboard/customers`: search, add, edit,
delete. Everything an owner actually wants to know about a customer existed in
the database and nowhere on screen.

Three concrete failures motivated it:

- **A person was many rows.** `0912…`, `۰۹۱۲…` and `+98912…` are one customer
  and three strings, so the same regular arrived as a new stranger every few
  visits, and every per-customer number was wrong in a way nobody could see.
- **Consent was a checkbox with no memory.** `sms_consent` was a boolean any
  screen could flip. When a customer says "who gave you permission to text me?"
  a boolean is not an answer.
- **There was no way to ask "who should I call?"** — no segments, no lifecycle,
  no follow-up list. The at-risk-customers tool existed for the *assistant* and
  had no screen behind it.

## Shape

A third app at **`/dashboard/crm`**, a peer of حسابداری and رشد و بازاریابی on
the workspace rail, with its own `AppKey` (`crm`), its own shell
(`crm-app-shell.tsx`) that owns the dashboard sidebar while you are inside it,
and nine sections:

| Section | Route | Who |
|---|---|---|
| میز کار ارتباط با مشتری | `/dashboard/crm` | owner/manager |
| مشتریان (directory) | `/dashboard/crm/directory` | + cashier |
| پروندهٔ مشتری (360°) | `/dashboard/crm/customers/[id]` | + cashier |
| بخش‌بندی (segments) | `/dashboard/crm/segments` | owner/manager |
| قیف فروش (deals) | `/dashboard/crm/deals` | owner/manager |
| کارها و پیگیری‌ها | `/dashboard/crm/activities` | + cashier |
| تیکت‌های خدمات | `/dashboard/crm/cases` | + cashier |
| مشتریان تکراری | `/dashboard/crm/duplicates` | owner/manager |
| رضایت ارتباط | `/dashboard/crm/consent` | owner/manager |

`/dashboard/customers` redirects to the directory, so bookmarks and saved
bottom-nav slots keep working. The old `customers-manager.tsx` was **moved**
(`git mv`) rather than rewritten, so its history follows it.

The role line is drawn differently from Growth's, and the reason is in
`crm-routes.ts`: Growth gates on *compensation*, the CRM gates on **who the
customer is**. The floor gets the directory, the file, follow-ups and the
service desk — the person who hears a complaint is the person at the counter,
and a ticket queue only the office can write to is one that never matches what
customers said. Segments, the pipeline, merge and the consent register are
management. **Accountants are admitted to nothing here**: the CRM posts no
journal entries, so there is no accounting reason to read customers' personal
data, and data with no reason to be read should not be reachable.

## Departures from #367

1. **Its own app, not sections of Growth.** #367 folded the CRM into the Growth
   app's rail. It is a peer app instead: the customer *record* is not a
   marketing engine, it is the thing five other apps point at. Growth keeps the
   audience *engines* (loyalty, campaigns, gift cards, commission); the CRM owns
   the record. `apps.test.ts` pins that split.
2. **The deal pipeline is in.** #367 listed "no deal pipeline" as out of scope.
   Built anyway, on the explicit instruction to make this the maximal version —
   with the constraint that made it safe to add: **a deal posts nothing.**

## The architecture rule, kept

Per the ecosystem's rule — *a new app adds modules, a section screen, read tools
and posting rules; not a second write path*:

- **No new ledger writes, and no new posting rule.** The CRM is the first app to
  add none at all. A deal's value is a forecast; revenue appears when a real
  sale settles through the sales path that already posts correctly. The
  store-credit figure on the dashboard is read from ledger account **۲۴۱۰** via
  `accountBalance()` — the same reconstruction the trial balance does.
- **A merge touches no accounting document.** It repoints who a sale is
  *attributed* to. `integration/crm.integration.test.ts` takes a full trial
  balance before and after a merge and demands they be **identical** — not
  "still balances", identical.
- **New tables only where there was no home**: `customer_segments`,
  `customer_notes`, `crm_activities`, `crm_deals`, `crm_cases`,
  `crm_consent_events`, `crm_merges`, all with the standard
  `ENABLE`+`FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy, plus RFM
  columns on `customers` and a canonical `phone_e164`.

## Load-bearing decisions

**Segments are a rule document, never SQL.** A saved segment is JSON;
`src/lib/segments.ts` compiles it to parameterised SQL against a closed union of
column expressions. No user string is ever interpolated. It is a pure module, so
the compiler is unit-tested without a database.

**Consent is enforced in the query, not the interface.** `resolveSegment` and
`previewSegment` take a required `purpose` (`view`/`sms`/`email`); an audience
for `sms` cannot contain a customer without permission, however the caller
phrases the request, because the filter is in the SQL. An unknown purpose fails
**closed**. `previewSegment` also returns `totalBeforeConsent`, so the UI says
«۱۲۰ نفر، ۴۵ نفر با اجازهٔ پیامک» — the gap is the useful fact, and a silently
smaller number is what makes people distrust the tool.

**Granted is not reachable.** Someone can tick "text me" and have no phone
number. Both are reported separately everywhere, because reporting only the
permission promises an audience that cannot be delivered to.

**The timeline is a mapping, not a table.** No events are copied; each source is
queried, capped *per source* (so 900 loyalty rows cannot push every order off
the page) and merged newest-first. Nothing to keep in sync, and no event can
disagree with the record it came from.

**A merge is explicit, previewed and irreversible.** Duplicates are *proposed*
by canonical phone, email, then name-at-low-confidence — «محمد محمدی» is not one
person, so a name match is offered as a question. The preview spells out what
moves. Tags union; **consent intersects**, so a merge can never manufacture a
permission neither record held. The loser is archived, never deleted, so nothing
that referenced it dangles. Nothing merges automatically at any confidence.

**RFM is stored, not derived on read**, and a null score means "not scored yet",
never zero — the difference between "this customer is bad" and "we have not
looked".

## What the assistant may and may not do

Four read tools (`find_customers`, `get_customer_timeline`,
`list_customer_segments`, `preview_customer_segment`) and exactly two writes
(`crm.customer.tag`, `crm.customer.note`). Both writes are internal marks that
reach nobody and are exactly reversible, so they are autopilot-eligible in the
existing «مشتری» category.

**No path may change consent, and merge is not an action.** Both are
irreversible judgements about a real person that must carry a human's name.
`ai.test.ts` asserts no catalogue endpoint contains `/consent` or `/merge`, so
the boundary cannot be crossed by a later edit that looks harmless.

`crm.customer.tag` takes **one** tag with `add`/`remove` rather than the whole
array, and the database does the append/remove on its own current value. The
older `customer.note.add` has to warn the model that sending `notes` replaces
everything — that warning is the bug; an endpoint whose only vocabulary is "add
this one" cannot silently erase someone else's work.

## Connections to the other apps

- **Sales** — orders are the timeline's spine and the source of every purchase
  aggregate; the file links to each order.
- **Accounting** — AR statement panel reused verbatim inside the directory;
  store credit read from ۲۴۱۰; the merge invariant above.
- **Growth** — loyalty points and repurchase intervals appear on the file;
  segments are what a future campaign sends to, which is why the consent filter
  lives below the send path rather than beside it.
- **Operations** — reservations and repair tickets appear on the timeline where
  the industry has them.

## Reports

Four, in the shared library (so they export, schedule and appear in
`list_reports` like everything else), over three new views in migration `0119`:
جذب مشتری تازه, ماندگاری و ریزش, ارزش طول عمر مشتری, پوشش رضایت ارتباط. Churn is
a distribution over lifecycle stages rather than one ratio: «۱۸٪ ریزش» tells an
owner nothing they can act on; «۴۰ مشتری در خطر» names who to call tomorrow.

All three views repeat the *same* "completed order, bucketed by
`app_business_date`, merged records excluded" rule the CRM's own screens use, so
a number in a report and a number on a customer's file are the same number.

## Exit criteria

- [x] `npx tsc --noEmit` clean.
- [x] `npm test` — 2689 unit tests pass.
- [x] `npm run test:db` — 783 integration tests across 84 files pass, including
      `crm.integration.test.ts` (8) and the tenant-isolation sweep over the new
      tables.
- [x] `npm run build` succeeds; all ten CRM routes compile.
- [x] `design-lint.test.ts` passes with no new baseline entries.
