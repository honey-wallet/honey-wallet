-- Group jars: two to five people buy one jar together in equal shares, held by a
-- Sputnik DAO on NEAR. The chain is the source of truth for money and votes; these
-- rows only track who was invited, who answered, what was verified on chain and what
-- each person should be told. Deleting a user deletes their rows (and the groups they
-- created).
--
-- `status`: inviting → creating → funding → buying → active → closed, or `solo` when
-- the creator chose to invest alone. `share_micro_usd` is each person's share.
CREATE TABLE social_groups (
    id uuid PRIMARY KEY,
    creator uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    -- The jar's id on the creator's phone; the published jar uses it as its client id.
    client_jar_id text NOT NULL CHECK (char_length(client_jar_id) BETWEEN 1 AND 80),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    thesis text NOT NULL DEFAULT '' CHECK (char_length(thesis) <= 280),
    picks jsonb NOT NULL,
    share_micro_usd bigint NOT NULL CHECK (share_micro_usd > 0),
    copy_fee smallint NOT NULL DEFAULT 10 CHECK (copy_fee BETWEEN 0 AND 30),
    hide_picks boolean NOT NULL DEFAULT false,
    -- Publish the jar (with its members) once the group's buy executes.
    publish boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'inviting'
        CHECK (status IN ('inviting', 'creating', 'funding', 'buying', 'active', 'closed', 'solo')),
    -- `<name>.sputnik-dao.near`, set once its members were checked on chain.
    dao text NULL CHECK (dao IS NULL OR char_length(dao) BETWEEN 2 AND 64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX social_groups_creator_idx ON social_groups (creator, created_at DESC);
-- One group per DAO.
CREATE UNIQUE INDEX social_groups_dao_idx ON social_groups (dao) WHERE dao IS NOT NULL;

-- Everyone in a group, the creator included (accepted from the start). An invite
-- lapses 7 days after `invited_at` (computed on read). `near_account` is the
-- member's NEAR implicit account, given when they accept. `paid_ref` is the verified
-- deposit (`near:<tx hash>` or `1click:<deposit address>`), counted once anywhere.
CREATE TABLE social_group_members (
    group_id uuid NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('invited', 'accepted', 'declined', 'lapsed', 'left')),
    near_account text NULL CHECK (near_account IS NULL OR char_length(near_account) BETWEEN 2 AND 64),
    paid_ref text NULL CHECK (paid_ref IS NULL OR char_length(paid_ref) BETWEEN 8 AND 160),
    paid_micro_usd bigint NULL,
    paid_at timestamptz NULL,
    invited_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    answered_at timestamptz NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX social_group_members_user_idx ON social_group_members (user_id);
CREATE UNIQUE INDEX social_group_members_paid_idx ON social_group_members (paid_ref)
    WHERE paid_ref IS NOT NULL;
CREATE UNIQUE INDEX social_group_members_account_idx ON social_group_members (group_id, near_account)
    WHERE near_account IS NOT NULL;

-- Votes the group opened on its DAO (checked on chain when recorded and on sync).
CREATE TABLE social_group_proposals (
    group_id uuid NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
    proposal_id bigint NOT NULL CHECK (proposal_id >= 0),
    kind text NOT NULL CHECK (kind IN ('buy', 'leave', 'cashout')),
    proposer uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'executed', 'failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz NULL,
    PRIMARY KEY (group_id, proposal_id)
);

-- What each person is told (the bell). No remote push in v1: the phone polls.
CREATE TABLE social_inbox (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('group_invite', 'group_ready', 'group_vote', 'group_update')),
    group_id uuid NULL REFERENCES social_groups(id) ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz NULL
);
CREATE INDEX social_inbox_user_idx ON social_inbox (user_id, created_at DESC);

-- Network fees Honey paid for a member of a group: at most once per person and group.
CREATE TABLE social_group_sponsorships (
    group_id uuid NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account text NOT NULL CHECK (char_length(account) BETWEEN 2 AND 64),
    yocto text NOT NULL CHECK (yocto ~ '^[0-9]{1,39}$'),
    tx_hash text NULL CHECK (tx_hash IS NULL OR char_length(tx_hash) <= 64),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX social_group_sponsorships_created_idx ON social_group_sponsorships (created_at);

-- A published group jar: owned by the creator, shown with its members.
ALTER TABLE social_jars
    ADD COLUMN group_id uuid NULL REFERENCES social_groups(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX social_jars_group_idx ON social_jars (group_id) WHERE group_id IS NOT NULL;
