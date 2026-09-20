-- Phase G (media persistence), Part 1 — media asset provenance.
--
-- The Media Library (0149) records WHO uploaded an asset (created_by) and
-- whether an AI refine produced it (variant/source_asset_id), but it cannot say
-- HOW an asset entered the library or WHAT it belongs to. The audit named this
-- the Part 21 gap: AI chat attachments and AI-generated images are deliberately
-- non-persistent (ai-attachment.ts: "nothing here touches a table or object
-- storage"), so a receipt a user pastes into chat, or an image the assistant
-- makes, vanishes when the turn ends — it never becomes a durable, taggable,
-- reusable library asset.
--
-- Closing that gap needs the library to distinguish a human upload from an
-- AI-originated one, and to remember the conversation/project an asset came
-- from so it can be shown back in that workspace. These four additive columns
-- are that vocabulary; the persistence write paths that use them land in the
-- following parts. Every column is nullable / has a backfill-safe default, so
-- every existing asset keeps its exact current meaning (a human upload, no
-- workspace) with no data migration.
--
--   source        — how the asset entered the library. 'upload' is the historic
--                   default (a person chose a file); 'ai_attachment' is a file
--                   a user sent to the assistant that we now keep; 'ai_generated'
--                   is an image the assistant produced. A CHECK pins the set so
--                   a typo can never create a fourth, unhandled provenance.
--   created_by_ai — true when the assistant, not a person, authored the bytes
--                   ('ai_generated'). Distinct from `source`: an ai_attachment
--                   is AI-*adjacent* but authored by the user, so it stays
--                   false. This is the flag the UI uses to badge "ساختهٔ دستیار".
--   conversation_id — the chat this asset came from, if any. ON DELETE SET NULL:
--                   deleting a conversation must not delete or orphan a library
--                   asset — the file outlives the thread that produced it.
--   project_id    — the project workspace this asset belongs to, if any. Same
--                   SET NULL reasoning as ai_conversations.project_id (0111):
--                   archiving/deleting a project never destroys its files.
--
-- No RLS change: media_assets already carries business_id and its
-- tenant_isolation policy (0149) covers every column. These add provenance,
-- not a new tenant boundary.

ALTER TABLE media_assets
    ADD COLUMN source text NOT NULL DEFAULT 'upload'
        CHECK (source IN ('upload', 'ai_attachment', 'ai_generated')),
    ADD COLUMN created_by_ai boolean NOT NULL DEFAULT false,
    ADD COLUMN conversation_id uuid NULL REFERENCES ai_conversations(id) ON DELETE SET NULL,
    ADD COLUMN project_id uuid NULL REFERENCES ai_projects(id) ON DELETE SET NULL;

-- The workspace reads — "the files from this conversation" and "the files in
-- this project" — are the new hot paths; index them the way 0111 indexed
-- ai_conversations.project_id (partial, non-null only).
CREATE INDEX idx_media_assets_conversation
    ON media_assets (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_media_assets_project
    ON media_assets (project_id) WHERE project_id IS NOT NULL;
