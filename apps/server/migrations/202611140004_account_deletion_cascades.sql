-- DELETE /me/account removes the person's users row and lets the cascades run.
-- These references to users (and the session/wallet rows under them) had no ON DELETE
-- action, so deleting a users row failed. Social, push, thesis and verified-identity
-- rows already cascade; gas_charges and evm_sponsorships keep their spend (SET NULL).
--
-- Fee sponsorship ledgers (jar_dao_relays, social_group_sponsorships) are kept like
-- gas_charges: their user and group become NULL instead of the rows going, so the daily
-- relay and sponsor totals stay right and an account Honey topped up is never topped up
-- again (social_group_sponsorships_account_idx). The sponsorships' (group_id, user_id)
-- primary key becomes a unique index, which allows those NULLs.
--
-- Deliberately unchanged: operations and the evidence chain under it (immutable by
-- trigger), and social_groups.creator (deletion is refused while the person shares a
-- group with others; routes/account_identity.rs).
--
-- Replaced (review): the first version was one transaction of DROP/ADD CONSTRAINT with
-- validation inside it. This one runs outside sqlx's transaction (no_tx in
-- database.rs) so each step commits on its own: every foreign key is added NOT VALID
-- (a short lock, no scan) and validated in a later transaction, and no step waits more
-- than 3 s for a lock. Every step can be repeated, so rerun it if one times out.

SET lock_timeout = '3s';

-- Sessions, wallets and identity events cascade from users.

BEGIN;
ALTER TABLE wallet_memberships
    DROP CONSTRAINT IF EXISTS wallet_memberships_user_id_fkey,
    ADD CONSTRAINT wallet_memberships_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE auth_refresh_families
    DROP CONSTRAINT IF EXISTS auth_refresh_families_user_id_fkey,
    ADD CONSTRAINT auth_refresh_families_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID,
    DROP CONSTRAINT IF EXISTS auth_refresh_families_wallet_id_user_id_fkey,
    ADD CONSTRAINT auth_refresh_families_wallet_id_user_id_fkey
        FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
        ON DELETE CASCADE NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE auth_refresh_tokens
    DROP CONSTRAINT IF EXISTS auth_refresh_tokens_family_id_fkey,
    ADD CONSTRAINT auth_refresh_tokens_family_id_fkey
        FOREIGN KEY (family_id) REFERENCES auth_refresh_families(id)
        ON DELETE CASCADE NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE auth_sessions
    DROP CONSTRAINT IF EXISTS auth_sessions_user_id_fkey,
    ADD CONSTRAINT auth_sessions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID,
    DROP CONSTRAINT IF EXISTS auth_sessions_wallet_id_user_id_fkey,
    ADD CONSTRAINT auth_sessions_wallet_id_user_id_fkey
        FOREIGN KEY (wallet_id, user_id) REFERENCES wallet_memberships(id, user_id)
        ON DELETE CASCADE NOT VALID,
    DROP CONSTRAINT IF EXISTS auth_sessions_refresh_family_fk,
    ADD CONSTRAINT auth_sessions_refresh_family_fk
        FOREIGN KEY (refresh_family_id) REFERENCES auth_refresh_families(id)
        ON DELETE CASCADE NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE wallet_link_challenges
    DROP CONSTRAINT IF EXISTS wallet_link_challenges_user_id_fkey,
    ADD CONSTRAINT wallet_link_challenges_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
COMMIT;

BEGIN;
ALTER TABLE identity_events
    DROP CONSTRAINT IF EXISTS identity_events_user_id_fkey,
    ADD CONSTRAINT identity_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;
COMMIT;

-- Fee sponsorship ledgers keep their rows without the person or the group.

BEGIN;
ALTER TABLE jar_dao_relays
    ALTER COLUMN user_id DROP NOT NULL,
    ALTER COLUMN group_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS jar_dao_relays_user_id_fkey,
    ADD CONSTRAINT jar_dao_relays_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID,
    DROP CONSTRAINT IF EXISTS jar_dao_relays_group_id_fkey,
    ADD CONSTRAINT jar_dao_relays_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES social_groups(id) ON DELETE SET NULL NOT VALID;
COMMIT;

-- Once per person and group, as the primary key was; built before the key is dropped.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS social_group_sponsorships_group_user_idx
    ON social_group_sponsorships (group_id, user_id);
COMMIT;

BEGIN;
ALTER TABLE social_group_sponsorships
    DROP CONSTRAINT IF EXISTS social_group_sponsorships_pkey,
    ALTER COLUMN user_id DROP NOT NULL,
    ALTER COLUMN group_id DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS social_group_sponsorships_user_id_fkey,
    ADD CONSTRAINT social_group_sponsorships_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL NOT VALID,
    DROP CONSTRAINT IF EXISTS social_group_sponsorships_group_id_fkey,
    ADD CONSTRAINT social_group_sponsorships_group_id_fkey
        FOREIGN KEY (group_id) REFERENCES social_groups(id) ON DELETE SET NULL NOT VALID;
COMMIT;

-- Validation scans the rows under a lock that still allows reads and writes.

BEGIN;
ALTER TABLE wallet_memberships VALIDATE CONSTRAINT wallet_memberships_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_refresh_families VALIDATE CONSTRAINT auth_refresh_families_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_refresh_families
    VALIDATE CONSTRAINT auth_refresh_families_wallet_id_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_refresh_tokens VALIDATE CONSTRAINT auth_refresh_tokens_family_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_wallet_id_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE auth_sessions VALIDATE CONSTRAINT auth_sessions_refresh_family_fk;
COMMIT;
BEGIN;
ALTER TABLE wallet_link_challenges VALIDATE CONSTRAINT wallet_link_challenges_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE identity_events VALIDATE CONSTRAINT identity_events_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE jar_dao_relays VALIDATE CONSTRAINT jar_dao_relays_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE jar_dao_relays VALIDATE CONSTRAINT jar_dao_relays_group_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE social_group_sponsorships
    VALIDATE CONSTRAINT social_group_sponsorships_user_id_fkey;
COMMIT;
BEGIN;
ALTER TABLE social_group_sponsorships
    VALIDATE CONSTRAINT social_group_sponsorships_group_id_fkey;
COMMIT;

RESET lock_timeout;
