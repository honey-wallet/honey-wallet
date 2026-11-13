-- Gas relays for group jars and remote push notifications.

-- Each NEP-366 delegate action Honey's relayer sent for a group member (POST
-- /jar-dao/relay): the per-person and daily budgets count these, and a relayed share
-- deposit is verified through the relayer's transaction (`tx_hash`).
CREATE TABLE jar_dao_relays (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id uuid NOT NULL REFERENCES social_groups(id) ON DELETE CASCADE,
    -- The member's implicit account (the delegate's sender) and what it called.
    sender text NOT NULL CHECK (char_length(sender) BETWEEN 2 AND 64),
    receiver text NOT NULL CHECK (char_length(receiver) BETWEEN 2 AND 64),
    methods text NOT NULL CHECK (char_length(methods) BETWEEN 1 AND 200),
    -- The relayer account that signed it.
    relayer text NOT NULL CHECK (char_length(relayer) BETWEEN 2 AND 64),
    tx_hash text NULL CHECK (tx_hash IS NULL OR char_length(tx_hash) <= 64),
    succeeded boolean NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX jar_dao_relays_user_idx ON jar_dao_relays (user_id, created_at);
CREATE INDEX jar_dao_relays_created_idx ON jar_dao_relays (created_at);
CREATE UNIQUE INDEX jar_dao_relays_tx_idx ON jar_dao_relays (tx_hash) WHERE tx_hash IS NOT NULL;

-- Expo push tokens, one row per device. A token belongs to whoever registered it last
-- (signing in as someone else on the same phone moves it). Deleting the user deletes
-- their tokens.
CREATE TABLE push_tokens (
    token text PRIMARY KEY CHECK (char_length(token) BETWEEN 10 AND 200),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform text NOT NULL CHECK (platform IN ('ios', 'android')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id, updated_at DESC);

-- The inbox doubles as the push outbox: an item is pushed once, when `pushed_at` is
-- claimed. Everything already in the inbox counts as pushed.
ALTER TABLE social_inbox ADD COLUMN pushed_at timestamptz NULL;
UPDATE social_inbox SET pushed_at = created_at;
CREATE INDEX social_inbox_unpushed_idx ON social_inbox (created_at) WHERE pushed_at IS NULL;
