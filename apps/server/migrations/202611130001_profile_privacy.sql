-- Profile privacy, like a public/private account. Every default keeps today's behaviour
-- for existing profiles. Owners always see their own data in full; these only change
-- what other people are served.
--   public_profile  off: you and your jars, theses and trades leave the feed, Explore,
--                   the leaderboard and "people you follow who hold this"; your profile
--                   shows others only a card (name, handle, avatar, follower counts).
--   show_holdings   off: your jars are served without their picks (tokens and split).
--   show_returns    off: no returns, sparklines or milestones; off the return rankings.
--   allow_copy      off: your jars can't be copied.
ALTER TABLE social_profiles
    ADD COLUMN public_profile boolean NOT NULL DEFAULT true,
    ADD COLUMN show_holdings boolean NOT NULL DEFAULT true,
    ADD COLUMN show_returns boolean NOT NULL DEFAULT true,
    ADD COLUMN allow_copy boolean NOT NULL DEFAULT true;

-- One jar published with its picks hidden ("Returns only"), whatever show_holdings says.
ALTER TABLE social_jars
    ADD COLUMN hide_picks boolean NOT NULL DEFAULT false;
