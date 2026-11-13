-- Creators' copy fees (2026-11-14): a cut of a copier's profit, paid through NEAR
-- Intents 1Click `appFees` on the copier's sell. The server works the fee out from these
-- rows, never from the phone: one row per buy leg quoted for a copy of a published jar,
-- with what it cost (micro-USD at 1Click's price when quoted) and the creator's fee then.
-- `units` (atomic units delivered) is filled from 1Click once the swap succeeds; only
-- settled rows count towards a copier's cost basis. Deleting the copier or the jar
-- deletes their rows.
CREATE TABLE copy_buy_lots (
    deposit_address text PRIMARY KEY CHECK (char_length(deposit_address) BETWEEN 8 AND 128),
    copier uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jar_id uuid NOT NULL REFERENCES social_jars(id) ON DELETE CASCADE,
    asset text NOT NULL CHECK (char_length(asset) BETWEEN 1 AND 200),
    cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd > 0),
    -- The jar's copy fee (percent of profit) when this was bought: a creator raising the
    -- fee later never charges people who copied at the lower one.
    fee_pct smallint NOT NULL CHECK (fee_pct BETWEEN 0 AND 30),
    units text NULL CHECK (units IS NULL OR units ~ '^[0-9]{1,38}$'),
    state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'settled', 'void')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL,
    CHECK ((state = 'settled') = (units IS NOT NULL))
);
CREATE INDEX copy_buy_lots_holding_idx ON copy_buy_lots (copier, jar_id, asset)
    WHERE state <> 'void';
