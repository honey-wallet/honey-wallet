-- Honey strategies (2026-11-14, the owner's decision): a few accounts Honey runs, each
-- with one real jar, seed the Feed, the Following suggestions and the Leaderboard while
-- people's own jars are few (routes/social/strategies.rs). `official` marks them, and
-- the app shows a Honey badge on them. Only `honey-server seed-honey-strategies` sets
-- it: PUT /social/me never touches it. The accounts have a `users` row and nothing else
-- (no wallet, no sign-in identity), and their jars are valued like everyone's, from
-- real prices since each jar started.
--
-- A NOT NULL column with a constant default: no table rewrite. No step waits more than
-- 3 s for a lock; rerun it if it times out.
SET lock_timeout = '3s';

ALTER TABLE social_profiles
    ADD COLUMN IF NOT EXISTS official boolean NOT NULL DEFAULT false;

-- The few official accounts, found without scanning every profile.
CREATE INDEX IF NOT EXISTS social_profiles_official_idx
    ON social_profiles (user_id) WHERE official;

RESET lock_timeout;
