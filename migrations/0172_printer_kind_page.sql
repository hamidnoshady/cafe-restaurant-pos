-- New printer purposes. PostgreSQL cannot use a value added in the same
-- transaction, so this file only extends the enum. 0173 uses the values.
ALTER TYPE printer_kind ADD VALUE IF NOT EXISTS 'label';
ALTER TYPE printer_kind ADD VALUE IF NOT EXISTS 'document';
