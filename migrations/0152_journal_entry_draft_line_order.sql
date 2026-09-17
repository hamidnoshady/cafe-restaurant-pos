-- «سند دستی» — a draft's rows must come back in the order they were typed.
--
-- journal_entry_draft_lines.id is `uuid DEFAULT gen_random_uuid()`, but
-- manual-journal-service.ts reads the rows back with `ORDER BY dl.id` — an
-- ordering by a *random* value. So the review queue showed a document's rows
-- shuffled: type 5100 / 5150 / 5160 / 5170 / 1100 and the reviewer is asked to
-- approve 5150 / 1100 / 5100 / 5160 / 5170. Nothing is miscalculated by it (a
-- balanced document is balanced in any order), but the person approving a
-- document cannot check it line by line against the paper it came from, and
-- the order changes again on the posted entry.
--
-- journal_lines never had the problem — its id is
-- `bigint GENERATED ALWAYS AS IDENTITY`, so `ORDER BY jl.id` there really is
-- insertion order. The drafts table is the one place that spells the key as a
-- random uuid, so it gets the explicit ordinal instead of a type change (the
-- primary key is referenced by nothing, but rewriting a key type is a bigger
-- and riskier change than adding the column the query actually wants).
--
-- Backfill is best-effort by construction: the original typing order of a
-- draft written before this migration is not recoverable from a random uuid.
-- Numbering by the existing `id` at least freezes each draft into the order it
-- has been displaying, so an open review queue does not reshuffle underneath
-- somebody mid-review.

ALTER TABLE journal_entry_draft_lines
    ADD COLUMN line_no integer NOT NULL DEFAULT 0;

UPDATE journal_entry_draft_lines l
   SET line_no = ordered.n
  FROM (
        SELECT id, (row_number() OVER (PARTITION BY draft_id ORDER BY id))::int - 1 AS n
          FROM journal_entry_draft_lines
       ) AS ordered
 WHERE ordered.id = l.id;

-- One ordinal per row per draft: the service assigns them from the submitted
-- array's index, so a duplicate would mean two rows claiming one position.
CREATE UNIQUE INDEX idx_journal_entry_draft_lines_draft_line_no
    ON journal_entry_draft_lines (draft_id, line_no);
