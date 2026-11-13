-- The social layer: public profiles, follows, published jars and the feed. Everything
-- here is opt-in: a user has no row until they claim a handle, a jar is public only
-- once published, and trades reach the feed only while `share_trades` is on.
-- Deleting the user deletes all of it.
CREATE TABLE social_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    handle text NOT NULL CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
    bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 160),
    -- Avatars are drawn on the phone from this seed: no remote image URL, so viewing a
    -- profile never tells a third-party host who is looking.
    avatar_seed text NOT NULL DEFAULT '' CHECK (char_length(avatar_seed) <= 64),
    share_trades boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX social_profiles_handle_idx ON social_profiles (handle);

CREATE TABLE social_follows (
    follower uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    followee uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (follower, followee),
    CHECK (follower <> followee)
);
CREATE INDEX social_follows_followee_idx ON social_follows (followee, created_at DESC);

-- `client_id` is the jar's id on the owner's phone, so publishing again updates it.
-- `picks` is [{symbol, chain, weight}]; `start_prices` is {symbol: usd} when those picks
-- were set. `base_value` is the value the jar had reached when they were set (1.0 at
-- first publish), so new picks continue its record instead of restarting it.
-- Publishing again after unpublishing keeps `published_at`, the marks and the milestone.
CREATE TABLE social_jars (
    id uuid PRIMARY KEY,
    owner uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 80),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    thesis text NOT NULL DEFAULT '' CHECK (char_length(thesis) <= 280),
    picks jsonb NOT NULL,
    start_prices jsonb NOT NULL,
    copy_fee smallint NOT NULL DEFAULT 10 CHECK (copy_fee BETWEEN 0 AND 30),
    base_value double precision NOT NULL DEFAULT 1 CHECK (base_value > 0),
    -- Highest +N% milestone already announced in the feed (0 = none).
    milestone smallint NOT NULL DEFAULT 0,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    unpublished_at timestamptz NULL,
    UNIQUE (owner, client_id)
);
CREATE INDEX social_jars_live_idx ON social_jars (published_at DESC) WHERE unpublished_at IS NULL;
CREATE INDEX social_jars_owner_live_idx ON social_jars (owner) WHERE unpublished_at IS NULL;

-- A jar's value index (1.0 at publish): one at publish, then one an hour from the
-- background marker (reads never write), so returns over a window and sparklines come
-- from real marks, not invented curves. Marks older than 400 days are pruned.
CREATE TABLE social_jar_marks (
    jar_id uuid NOT NULL REFERENCES social_jars(id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    value double precision NOT NULL CHECK (value > 0),
    PRIMARY KEY (jar_id, at)
);

-- One row per person who copied a jar; a jar's copies are counted from these rows, so a
-- copier deleting their account takes their copy with them.
CREATE TABLE social_jar_copies (
    jar_id uuid NOT NULL REFERENCES social_jars(id) ON DELETE CASCADE,
    copier uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (jar_id, copier)
);
CREATE INDEX social_jar_copies_copier_idx ON social_jar_copies (copier);

-- A thesis: "this is my thesis" in a few lines about 1–3 tokens. `tokens` is
-- [{symbol, chain, price}] with each token's 1Click price when it was posted, so the
-- feed shows how the call has done since. Deleting a post removes it from the feed.
CREATE TABLE social_posts (
    id uuid PRIMARY KEY,
    author uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
    tokens jsonb NOT NULL,
    jar_id uuid NULL REFERENCES social_jars(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX social_posts_author_idx ON social_posts (author, created_at DESC);
-- Theses about a token are found newest first (a token page shows the latest 20).
CREATE INDEX social_posts_created_idx ON social_posts (created_at DESC);

CREATE TABLE social_events (
    id bigserial PRIMARY KEY,
    actor uuid NOT NULL REFERENCES social_profiles(user_id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('jar_published', 'jar_copied', 'trade', 'jar_milestone', 'thesis')),
    jar_id uuid NULL REFERENCES social_jars(id) ON DELETE CASCADE,
    post_id uuid NULL REFERENCES social_posts(id) ON DELETE CASCADE,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- For trades: the NEAR Intents deposit address 1Click verified. Never sent to clients
    -- (it would tie the profile to an on-chain wallet); one post per swap.
    operation_id text NULL CHECK (operation_id IS NULL OR char_length(operation_id) BETWEEN 8 AND 128),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX social_events_actor_idx ON social_events (actor, id DESC);
CREATE INDEX social_events_jar_idx ON social_events (jar_id) WHERE jar_id IS NOT NULL;
CREATE INDEX social_events_post_idx ON social_events (post_id) WHERE post_id IS NOT NULL;
CREATE UNIQUE INDEX social_events_trade_operation_idx ON social_events (operation_id)
    WHERE kind = 'trade';
