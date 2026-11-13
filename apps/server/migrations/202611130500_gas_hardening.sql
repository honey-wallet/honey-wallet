-- Free gas hardening (src/gas_allowance.rs, src/solana_relayer.rs, src/evm_sponsor.rs).
--
-- gas_charges:
--   native_atomic      what a reservation may move out of the relayer in its native coin
--                      (lamports, yoctoNEAR, wei), so a relayer's floor is checked against
--                      its balance minus every reservation still pending.
--   exempt_usd_micros  the part of a charge capped by its own rule (Solana rent, counted
--                      in new_accounts; a group DAO's NEAR deposit, one per group), left
--                      out of the per-person per-chain daily cap.
ALTER TABLE gas_charges
    ADD COLUMN native_atomic numeric(40, 0) NULL
        CHECK (native_atomic IS NULL OR native_atomic >= 0),
    ADD COLUMN exempt_usd_micros bigint NOT NULL DEFAULT 0 CHECK (exempt_usd_micros >= 0);
CREATE INDEX gas_charges_pending_idx ON gas_charges (chain, created_at) WHERE state = 'pending';
CREATE INDEX gas_charges_user_chain_idx ON gas_charges (user_id, chain, created_at);

-- evm_sponsorships: a relayer transaction that hasn't landed is never simply forgotten.
-- Its signed bytes and fees are kept so Honey can resend it with higher fees, and past the
-- wallet's deadline replace it with a zero-value transfer to itself at the same nonce;
-- the charge stays until that nonce is mined.
ALTER TABLE evm_sponsorships
    ADD COLUMN raw_tx text NULL
        CHECK (raw_tx IS NULL OR (raw_tx ~ '^0x[0-9a-f]+$' AND char_length(raw_tx) <= 65536)),
    ADD COLUMN max_fee_wei text NULL CHECK (max_fee_wei IS NULL OR max_fee_wei ~ '^[0-9]{1,39}$'),
    ADD COLUMN tip_wei text NULL CHECK (tip_wei IS NULL OR tip_wei ~ '^[0-9]{1,39}$'),
    -- Every later transaction at this nonce: fee bumps of the original, then the cancel.
    ADD COLUMN later_hashes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN cancel_hash text NULL CHECK (cancel_hash IS NULL OR cancel_hash ~ '^0x[0-9a-f]{64}$'),
    ADD COLUMN bumps integer NOT NULL DEFAULT 0 CHECK (bumps BETWEEN 0 AND 16),
    ADD COLUMN bumped_at timestamptz NULL;
ALTER TABLE evm_sponsorships DROP CONSTRAINT evm_sponsorships_status_check;
ALTER TABLE evm_sponsorships ADD CONSTRAINT evm_sponsorships_status_check
    CHECK (status IN ('sent', 'success', 'reverted', 'dropped', 'replaced'));
CREATE INDEX evm_sponsorships_unsettled_idx ON evm_sponsorships (created_at) WHERE status = 'sent';
