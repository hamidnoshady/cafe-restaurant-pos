# Phase 33 — making the assistant usable

## Why

Phase 32 gave the assistant standing instructions. This phase is about the far
more basic problem underneath: using it did not feel like using a chat, and the
answers it gave were not grounded enough to trust.

Every item below is a reproduced complaint from an owner using the product on a
phone, not a speculative improvement.

## The surface

**A cost estimate gated every single message.** Typing anything — «سلام» included
— POSTed to `/api/ai/estimate`, then parked the turn behind a «برآورد هزینه …
شروع پاسخ» card that had to be tapped before the assistant would say a word.
Two round trips and an extra tap for every message.

The card was not buying the safety it appeared to: `/api/ai/chat` performs its
own credit reservation against `config.maxTurnRial` and refuses when there is no
credit, entirely independently of the estimate call. So the gate is gone from
the send path, and the **actual** settled charge is now shown quietly under each
reply — truthful, and free. `/api/ai/estimate` still exists for anyone who wants
a pre-flight number; nothing is forced through it.

**Two progress indicators ran at once.** The empty assistant bubble said «در حال
دریافت پاسخ…» while a second bubble underneath said «پاسخ به‌صورت زنده در حال
دریافت است…». Now there is one typing indicator, and it is three dots — a chat
signals typing, it does not narrate.

**Markdown was never rendered.** Replies were drawn with `whitespace-pre-wrap`,
so a table arrived as a wall of `|---|---|` pipes and emphasis arrived as
literal `**` asterisks (see the reply that started this phase). Replies now go
through `ai-markdown.tsx`, built for the one screen that matters:

- anything intrinsically wide — a table, a code block, a long unbroken token —
  is either given its own horizontally scrolling box or forced to break, so the
  **page** never scrolls sideways;
- lists indent and tables align to the right, taking direction from the app
  shell rather than fighting it;
- margins are chat-bubble tight, and the first and last child lose their outer
  margin so a bubble does not grow a band of empty space.

## The substance

**It asked for UUIDs.** Told «نان چند تکه مونده؟», the assistant replied asking
for an `inventoryItemId`. The owner knows the name; ids are the software's
problem. `find_items` resolves a partial Persian name across inventory items and
menu items and returns everything needed to act without a second question.

**It said "not found" for items that exist.** A disabled item returned nothing,
sending the owner hunting for a typo. `find_items` returns `isActive` and a
Persian `statusLabel`, and the prompt states that «غیرفعال است» is a correct
answer, not a miss.

**It showed raw database values to a Persian-speaking user** — «موارد ثبت‌شده
تحت دلایل «spoilage» و «staff_meal»». The model was not being lazy; those were
the only strings the tools ever handed it. `ai-labels.ts` now carries the
Persian label for every enum the tools surface, and each tool returns the label
next to the value.

The fix belongs in the tool, not the prompt: a label the tool returns is a fact,
while a label the model translates on the fly is a guess — and a confident guess
about what a status *means* is exactly what makes an owner stop trusting the
feature.

**It could not answer the question it was asked.** «تمام دیتای ضایعات نان در
تمام تاریخ‌ها» sent it to `get_stock_valuation`, which knows only what is on the
shelf *now* and nothing about what left it. `get_waste_history` answers that
question directly: by item and reason, with quantities, entry counts, the date
range and the cost in both Rial and Toman.

**It did not know what product it was inside.** The app has five industries,
per-trade modules, per-business feature flags and several branches, and the
assistant knew none of it — so it offered things this business cannot do and
missed things it can. `describe_app` reports the trade, its branches, its
modules, its enabled features, the trade's own vocabulary («سفارش» vs «فاکتور»)
and the full list of actions the assistant may propose.

**Money arithmetic was the model's job.** It is now the tool's: every monetary
field comes back as `{ rial, toman, text }`, because a model dividing by ten in
its head produces a wrong number about money, which is the worst thing this
feature can output.

## Exit criteria

| Criterion | Where |
|---|---|
| Sending a message goes straight to the answer | `sendMessage` in `use-ai-chat.ts` |
| The real charge is shown, not a pre-send guess | `costRial` on the `done` event; `ai-chat-messages.tsx` |
| One typing indicator | `TypingDots` |
| Markdown renders; the page never scrolls sideways | `ai-markdown.tsx` |
| A Persian name resolves to an id without asking the user | `integration/ai-orientation-tools.integration.test.ts` |
| A disabled item reads as disabled, not missing | same file |
| Waste history answers by item and reason, in Persian | same file |
| No raw enum value can reach the reply | same file — asserts `spoilage` is absent |
| The assistant knows this business's trade, branches and modules | same file |
| The prompt forbids ids, raw codes and desktop-shaped answers | `ai.test.ts` — "the assistant's manners" |

## Deliberately not in scope

- **Changing the model.** Answer quality also depends on which model the
  platform is configured with (`platform_ai_config`); the default is a small,
  cheap one. This phase makes the *grounding* good — the model can no longer be
  wrong because it lacked the data. Choosing a stronger model is a platform
  setting and a cost decision, not a code change.
- **Documenting every screen to the assistant.** `describe_app` orients it
  (trade, modules, branches, what it may change). A full capability description
  of every function in the product is a larger body of work and wants its own
  phase.
