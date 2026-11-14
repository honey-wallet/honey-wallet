-- Honey keeps the copy fee (2026-11-14, the owner's decision): a copier's sell pays one
-- 1Click `appFees` entry to Honey's own NEAR Intents account (HONEY_COPY_FEE_ACCOUNT)
-- instead of one per creator (copy_fees.rs). copy_sale_fees still records what was
-- received per jar whose copies paid it, for accounting; `recipient` now says who was
-- paid. NULL on rows written before this: those were paid to the jar's creator.
-- `creator` stays the jar's creator (whose jar the copies came from), not the payee.
--
-- A nullable column with a short CHECK: no rewrite, and the table is small. No step
-- waits more than 3 s for a lock; rerun it if it times out.
SET lock_timeout = '3s';

ALTER TABLE copy_sale_fees
    ADD COLUMN IF NOT EXISTS recipient text NULL
        CHECK (recipient IS NULL OR char_length(recipient) BETWEEN 2 AND 64);

RESET lock_timeout;
