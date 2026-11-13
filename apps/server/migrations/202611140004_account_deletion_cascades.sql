-- DELETE /me/account removes the person's users row and lets the cascades run.
-- These references to users (and the session/wallet rows under them) had no ON DELETE
-- action, so deleting a users row failed. Social, push, thesis, verified-identity and
-- group-jar rows already cascade; gas_charges and evm_sponsorships keep their spend
-- (SET NULL) so daily budgets stay right.
--
-- Deliberately unchanged: operations and the evidence chain under it (operation_intents,
-- preparations, EVM submissions, signed transactions, reconciliation, bridge watches).
-- Those rows are immutable by trigger, so a person with operations keeps a bare users
-- row and the wallet memberships their operations name; everything else is removed
-- (routes/account_identity.rs).

ALTER TABLE wallet_memberships
    DROP CONSTRAINT wallet_memberships_user_id_fkey,
    ADD CONSTRAINT wallet_memberships_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE auth_refresh_families
    DROP CONSTRAINT auth_refresh_families_user_id_fkey,
    ADD CONSTRAINT auth_refresh_families_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    DROP CONSTRAINT auth_refresh_families_wallet_id_user_id_fkey,
    ADD CONSTRAINT auth_refresh_families_wallet_id_user_id_fkey
        FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
        ON DELETE CASCADE;

ALTER TABLE auth_refresh_tokens
    DROP CONSTRAINT auth_refresh_tokens_family_id_fkey,
    ADD CONSTRAINT auth_refresh_tokens_family_id_fkey
        FOREIGN KEY (family_id) REFERENCES auth_refresh_families(id) ON DELETE CASCADE;

ALTER TABLE auth_sessions
    DROP CONSTRAINT auth_sessions_user_id_fkey,
    ADD CONSTRAINT auth_sessions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    DROP CONSTRAINT auth_sessions_wallet_id_user_id_fkey,
    ADD CONSTRAINT auth_sessions_wallet_id_user_id_fkey
        FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
        ON DELETE CASCADE,
    DROP CONSTRAINT auth_sessions_refresh_family_fk,
    ADD CONSTRAINT auth_sessions_refresh_family_fk
        FOREIGN KEY (refresh_family_id) REFERENCES auth_refresh_families(id)
        ON DELETE CASCADE;

ALTER TABLE wallet_link_challenges
    DROP CONSTRAINT wallet_link_challenges_user_id_fkey,
    ADD CONSTRAINT wallet_link_challenges_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE identity_events
    DROP CONSTRAINT identity_events_user_id_fkey,
    ADD CONSTRAINT identity_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
