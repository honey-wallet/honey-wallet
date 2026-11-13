-- Honey's free gas, in US dollar micros (1 USD = 1,000,000): every signed-in person gets
-- an allowance per rolling 30 days across all chains, and each chain has a daily total
-- across everyone (src/gas_allowance.rs). One row per sponsored transaction: `pending`
-- while its cost is reserved and the outcome unknown, `settled` at what it really cost.
-- A reservation released because nothing was spent is deleted.
CREATE TABLE gas_charges (
    id uuid PRIMARY KEY,
    -- SET NULL, not CASCADE: deleting an account must not hand a chain's daily total back.
    user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    chain text NOT NULL CHECK (chain ~ '^[a-z0-9_]{1,32}$'),
    usd_micros bigint NOT NULL CHECK (usd_micros >= 0),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settled')),
    -- What paid it: 'solana_fee_payer', 'near_relay', 'jar_dao_relay', 'jar_dao_sponsor', ...
    kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 40),
    -- New accounts whose rent Honey paid (Solana token accounts), capped per person.
    new_accounts integer NOT NULL DEFAULT 0 CHECK (new_accounts BETWEEN 0 AND 16),
    -- The transaction it paid for (Solana signature, NEAR hash): one charge per transaction.
    reference text NULL CHECK (reference IS NULL OR char_length(reference) BETWEEN 1 AND 128),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL
);
CREATE INDEX gas_charges_user_idx ON gas_charges (user_id, created_at);
CREATE INDEX gas_charges_chain_idx ON gas_charges (chain, created_at);
CREATE UNIQUE INDEX gas_charges_reference_idx ON gas_charges (chain, reference)
    WHERE reference IS NOT NULL;
