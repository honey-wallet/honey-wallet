-- Stealth-jar unit ledgers: ciphertext only. `box_id` and `token_hash` are derived on
-- members' devices from the jar's ledger key, so a row is not linkable to a NEAR account.
CREATE TABLE stealth_jar_ledgers (
    box_id text PRIMARY KEY CHECK (box_id ~ '^[0-9a-f]{32}$'),
    token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    version bigint NOT NULL CHECK (version >= 1),
    ciphertext text NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 65536),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
