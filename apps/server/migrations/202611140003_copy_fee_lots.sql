-- Creators' copy fees (2026-11-14): a cut of a copier's profit, paid through NEAR
-- Intents 1Click `appFees` on the copier's sell. The server works the fee out from these
-- rows, never from the phone: one row per buy leg quoted for a copy of a published jar,
-- with what it cost (micro-USD at 1Click's price when quoted) and the creator's fee then.
-- `units` (atomic units delivered) is filled from 1Click once the swap succeeds; only
-- settled rows count towards a copier's cost basis. Deleting the copier or the jar
-- deletes their rows.
--
-- Every sell of an asset a copier holds copied units of pays the fee, oldest copy first
-- (FIFO), whatever the phone says the sell is: `sold` counts a lot's units already sold
-- (by sells 1Click confirmed), and only `units - sold` is still charged on.
CREATE TABLE copy_buy_lots (
    deposit_address text PRIMARY KEY CHECK (char_length(deposit_address) BETWEEN 8 AND 128),
    -- FIFO order.
    seq bigserial NOT NULL UNIQUE,
    copier uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    jar_id uuid NOT NULL REFERENCES social_jars(id) ON DELETE CASCADE,
    asset text NOT NULL CHECK (char_length(asset) BETWEEN 1 AND 200),
    cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd > 0),
    -- The jar's copy fee (percent of profit) when this was bought: a creator raising the
    -- fee later never charges people who copied at the lower one.
    fee_pct smallint NOT NULL CHECK (fee_pct BETWEEN 0 AND 30),
    -- units text NULL CHECK (units IS NULL OR units ~ '^[0-9]{1,38}$'),
    units numeric(39, 0) NULL CHECK (units IS NULL OR units > 0),
    sold numeric(39, 0) NOT NULL DEFAULT 0 CHECK (sold >= 0),
    state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'settled', 'void')),
    -- 1Click's own deadline for the deposit address (days past the app's): a buy still
    -- unpaid after it is void.
    expires_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL,
    CHECK ((state = 'settled') = (units IS NOT NULL)),
    CHECK (units IS NULL OR sold <= units)
);
-- CREATE INDEX copy_buy_lots_holding_idx ON copy_buy_lots (copier, jar_id, asset)
--     WHERE state <> 'void';
CREATE INDEX copy_buy_lots_open_idx ON copy_buy_lots (copier, asset, seq)
    WHERE state = 'settled' AND sold < units;
CREATE INDEX copy_buy_lots_quoted_idx ON copy_buy_lots (copier, asset)
    WHERE state = 'quoted';

-- A quoted sell of copied units (one 1Click deposit address) and the lots it sells from.
-- Its parts count as sold only once 1Click says the sell succeeded.
CREATE TABLE copy_sales (
    deposit_address text PRIMARY KEY CHECK (char_length(deposit_address) BETWEEN 8 AND 128),
    copier uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset text NOT NULL CHECK (char_length(asset) BETWEEN 1 AND 200),
    state text NOT NULL DEFAULT 'quoted' CHECK (state IN ('quoted', 'settled', 'void')),
    expires_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL
);
CREATE INDEX copy_sales_quoted_idx ON copy_sales (copier, asset, created_at DESC)
    WHERE state = 'quoted';

CREATE TABLE copy_sale_parts (
    sale text NOT NULL REFERENCES copy_sales(deposit_address) ON DELETE CASCADE,
    lot text NOT NULL REFERENCES copy_buy_lots(deposit_address) ON DELETE CASCADE,
    units numeric(39, 0) NOT NULL CHECK (units > 0),
    PRIMARY KEY (sale, lot)
);
