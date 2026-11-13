-- Honey's NEAR relayer pays network fees for group jars (POST /jar-dao/sponsor and
-- /jar-dao/relay). Budgets are NEAR amounts, not counts, and the DAO a relay touches
-- must still run the code Honey saw when the group created it.

-- What each relay cost Honey's relayer, in yoctoNEAR: a reservation (its attached gas
-- at NEAR's minimum gas price) until the outcome is known, then the tokens it burnt.
ALTER TABLE jar_dao_relays
    ADD COLUMN gas_yocto text NOT NULL DEFAULT '0' CHECK (gas_yocto ~ '^[0-9]{1,39}$');

-- The DAO's code hash (base58) when Honey checked the group's DAO at /created: the
-- Sputnik factory's default code then. A relay is refused once the DAO runs anything else.
ALTER TABLE social_groups
    ADD COLUMN dao_code_hash text NULL
        CHECK (dao_code_hash IS NULL OR char_length(dao_code_hash) BETWEEN 32 AND 64);

-- An account is topped up at most once ever, whoever asks and from whichever group.
CREATE UNIQUE INDEX social_group_sponsorships_account_idx ON social_group_sponsorships (account);
CREATE INDEX social_group_sponsorships_user_idx ON social_group_sponsorships (user_id, created_at);

-- A wallet session's Sign in with Apple or Google (a Firebase user), one to one: an
-- Apple or Google account vouches for one Honey wallet. Used to gate fee sponsoring
-- when SPONSOR_REQUIRE_VERIFIED_IDENTITY=1 and to key 1Click quote quotas per person.
CREATE TABLE user_verified_identities (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    firebase_uid text NOT NULL UNIQUE CHECK (char_length(firebase_uid) BETWEEN 1 AND 128),
    provider text NOT NULL CHECK (provider IN ('apple.com', 'google.com')),
    linked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
