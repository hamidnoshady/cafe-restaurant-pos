# Phase 37 — SMS/email marketing (messaging, metered and posted)

> **Numbering note.** The *name* "Phase 37" was reused earlier in this index for
> the unrelated LiteLLM Gateway phase; the messaging work below is a separate
> feature that happens to share the GitHub issue number range #372–#377. It is
> filed here as **37b** in the index to keep the two apart, exactly as 23b/18b
> disambiguate collisions elsewhere in this repo.

A café owner who could say «این گروه» (this group) to a CRM segment can now send
that group a message — and the cost of doing so lands in the business's own
ledger. It is metered like Phase 18's AI credits (platform-owned, reserved →
settled → refunded, a balance that is always the SUM of a signed ledger) and
posted like every auto-posted entry (a domain event turned into one journal
document by the posting engine, dated on the branch's business day).

Status: **Waves 1–4 engine implemented and unit-tested.** Wave 5 (coworker-
triggered sends, project cost-centre reporting and the ROI report) is specified
below but not yet shipped.

## Scope

- A message is a *closed* template variable set over text (`src/lib/message-template.ts`).
- The audience comes from ONLY `resolveSegment(..., { purpose })` via the CRM→
  Growth bridge (`campaign-audience.ts`) — consent and a reachable address are
  enforced there, never by a caller remembering to filter.
- Sending goes through the `message_outbox` and the `runMessagingTick()` on the
  custom server — nothing is sent inline.
- The provider relationship (Kavenegar for SMS, SMTP for email) is the
  platform's, never a business's own key.
- **The model never sends.** Phase 31 stands; a template/campaign preview and a
  *draft* are all an assistant can produce. Sending is a human pressing a button.

## Waves

### Wave 1 (#373) — platform message config & credits

Migration `0133_platform_message_credits.sql` mirrors Phase 18's AI billing:
`platform_message_config`, `message_credit_packages`, `message_business_billing`,
`message_credit_ledger`, `message_top_up_requests`. Provider credentials are
AES-GCM encrypted at rest with the realm secret and never returned to a business.
`src/lib/messaging-billing-pure.ts` owns the Persian SMS segment count (UCS-2:
70 chars first segment, 67 after) and the Rial cost; `src/lib/messaging-billing.ts`
owns reserve/settle/refund and the console + business pages' data.

Exit: super-admin configures provider + rate; owner sees balance/history and
requests a top-up; a business with insufficient credit is stopped *before* any
send attempt; balance is always a ledger SUM.

### Wave 2 (#374) — templates, campaigns, outbox

Migration `0134_message_campaigns.sql`: `message_templates`, `message_campaigns`,
`message_recipients` (a send-time snapshot — a segment that later changes never
rewrites who was told), `message_outbox`. `src/lib/message-campaigns-service.ts`
validates templates (unknown `{{…}}` variable = save-time error), materialises
the audience and queues it. `src/lib/message-outbox-service.ts` drains the queue
per business with exponential backoff, retry cap, pause, and self-swallowed
errors.

Exit: a 10-person segment send writes 10 snapshot recipients; an unconsented
member is never a recipient; segment drift after send changes nothing; a failed
send retries then fails with a Persian error; a paused campaign refunds its
unused reservation.

### Wave 3 (#375) — adapters behind one seam

`src/lib/messaging/provider.ts` is the `MessageProvider` seam (`retryable` is the
adapter's decision). Kavenegar is split pure/network (`kavenegar.ts` builds &
parses fixtures, `kavenegar-client.ts` does the fetch); SMTP uses nodemailer
(`providers/smtp.ts`). Every provider error maps to an internal code with a
Persian label (Phase 33's rule). No test ever dials a live provider.

### Wave 4 (#376) — marketing expense, posted by the engine

`5600 هزینهٔ تبلیغات و بازاریابی` is already on every COA template (verified, and
added to `CORE_REQUIRED_CODES`). Migration `0135` adds the credit side —
`2455 پرداختنی به پلتفرم (اعتبار پیام)` — to every business's chart additively.
`src/lib/message-cost-posting.ts` registers the `message.campaign_cost` posting
rule and, when a campaign drains to completion, posts **one** document
(Debit 5600 / Credit 2455) at the branch business day for exactly what went out.
A locked fiscal period routes it through the engine's exact posting path to the
human-approval queue; it never stops a real spend being recognised.

### Wave 5 (#377) — not yet shipped

Specified, not built: event-triggered messages (a deterministic coworker event
that creates a single-recipient campaign and respects `approvalMode` and the
Phase 31 batch caps with a deterministic unique index for idempotency), campaigns
charged to a project (cost centre) with project spend reporting, and campaign ROI
derived only from a dedicated promo code.

## Guardrails (add to CLAUDE.md when the phase ships fully)

> **پیام مشتری‌رو، اعتبار پلتفرمی دارد و در دفتر می‌نشیند.** Sending runs through
> the outbox + tick; its cost is turned into one journal document per campaign by
> the posting engine — never a hand-written ledger call — dated on the branch's
> business day.
>
> **مدل نمی‌فرستد.** Phase 31 stands; the only exception is a pre-authorised
> coworker job, still bounded by Phase 31 batch caps.
