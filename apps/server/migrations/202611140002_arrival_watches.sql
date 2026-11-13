-- "Money received" pushes (src/arrivals.rs). Each phone sends, with its push token, the
-- wallets it wants arrival pushes for: its EVM, Solana and NEAR addresses (the server
-- only proves EVM wallets at sign-in, so the phone names the rest). An empty list means
-- the setting is off on that phone. Phones that never sent a list (older builds) are
-- watched on their person's signed-in EVM wallets (wallet_memberships).
-- Removing the token (signing out, Expo saying it's gone) removes its wallets.
ALTER TABLE push_tokens ADD COLUMN wallets_declared boolean NOT NULL DEFAULT false;

CREATE TABLE push_wallets (
    token text NOT NULL REFERENCES push_tokens(token) ON DELETE CASCADE,
    evm text NULL CHECK (evm IS NULL OR evm ~ '^0x[0-9a-f]{40}$'),
    solana text NULL CHECK (solana IS NULL OR char_length(solana) BETWEEN 32 AND 44),
    near text NULL CHECK (near IS NULL OR char_length(near) BETWEEN 2 AND 64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (evm IS NOT NULL OR solana IS NOT NULL OR near IS NOT NULL)
);
CREATE UNIQUE INDEX push_wallets_unique_idx
    ON push_wallets (token, coalesce(evm, ''), coalesce(solana, ''), coalesce(near, ''));
-- Sender lookups ("from @alice") by any of the three addresses.
CREATE INDEX push_wallets_evm_idx ON push_wallets (evm) WHERE evm IS NOT NULL;
CREATE INDEX push_wallets_solana_idx ON push_wallets (solana) WHERE solana IS NOT NULL;
CREATE INDEX push_wallets_near_idx ON push_wallets (near) WHERE near IS NOT NULL;
