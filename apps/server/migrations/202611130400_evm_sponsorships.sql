-- EIP-7702 gas sponsorship on Base, Arbitrum and Polygon (src/evm_sponsor.rs): one row
-- per transaction Honey's EVM relayer sent for a wallet. The dollars live in the shared
-- gas ledger (gas_charges, `charge_id`); this table keeps what's needed to settle a charge
-- from its receipt, to send one transaction per account at a time, and to keep the
-- relayer's nonces unique across replicas.
CREATE TABLE evm_sponsorships (
    id uuid PRIMARY KEY,
    user_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
    -- gas_charges.id (no foreign key: a released charge is deleted) and what it reserved.
    charge_id uuid NOT NULL,
    charge_usd_micros bigint NOT NULL CHECK (charge_usd_micros >= 0),
    chain_id bigint NOT NULL CHECK (chain_id IN (8453, 42161, 137)),
    -- Lowercase 0x hex.
    account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
    relayer text NOT NULL CHECK (relayer ~ '^0x[0-9a-f]{40}$'),
    relayer_nonce bigint NOT NULL CHECK (relayer_nonce >= 0),
    tx_hash text NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
    -- The EIP-712 digest the wallet signed (also the ledger charge's reference).
    digest text NOT NULL UNIQUE CHECK (digest ~ '^0x[0-9a-f]{64}$'),
    -- Whether it carried the wallet's 7702 authorization (its first time on this chain).
    delegated boolean NOT NULL,
    reserved_wei text NOT NULL CHECK (reserved_wei ~ '^[0-9]{1,39}$'),
    -- USD per native coin when reserved; the receipt's cost is priced the same.
    native_usd double precision NOT NULL CHECK (native_usd > 0),
    status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'success', 'reverted', 'dropped')),
    actual_wei text NULL CHECK (actual_wei IS NULL OR actual_wei ~ '^[0-9]{1,39}$'),
    actual_usd_micros bigint NULL CHECK (actual_usd_micros IS NULL OR actual_usd_micros >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL
);
-- One unsettled transaction per account and chain.
CREATE UNIQUE INDEX evm_sponsorships_sent_idx ON evm_sponsorships (chain_id, account)
    WHERE status = 'sent';
CREATE INDEX evm_sponsorships_relayer_idx ON evm_sponsorships (chain_id, relayer, created_at);
CREATE INDEX evm_sponsorships_user_idx ON evm_sponsorships (user_id, created_at);
