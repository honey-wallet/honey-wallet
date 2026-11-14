-- Honey pays gas on Optimism too (2026-11-14, src/evm_sponsor.rs): its sponsored
-- transactions (chain 10) are recorded like Base's. The chain list was a CHECK of the
-- first three chains, so the first Optimism submit failed on it (nothing was sent).
--
-- The new CHECK is added NOT VALID and then validated: no step holds a long lock, and
-- every existing row is on one of the three chains it already allowed. No step waits
-- more than 3 s for a lock; rerun it if it times out.
SET lock_timeout = '3s';

ALTER TABLE evm_sponsorships DROP CONSTRAINT IF EXISTS evm_sponsorships_chain_id_check;
ALTER TABLE evm_sponsorships
    ADD CONSTRAINT evm_sponsorships_chain_id_check
        CHECK (chain_id IN (8453, 42161, 137, 10)) NOT VALID;
ALTER TABLE evm_sponsorships VALIDATE CONSTRAINT evm_sponsorships_chain_id_check;

RESET lock_timeout;
