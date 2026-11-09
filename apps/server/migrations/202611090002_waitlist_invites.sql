-- "You're off the waitlist" emails. Set by `honey-server invite-waitlist` after Resend
-- accepts the message; NULL means not invited yet. Account deletion deletes the row,
-- and these columns with it.
ALTER TABLE waitlist
    ADD COLUMN invited_at timestamptz NULL,
    ADD COLUMN invite_message_id text NULL CHECK (octet_length(invite_message_id) <= 200);

CREATE INDEX waitlist_uninvited_idx ON waitlist (created_at, id) WHERE invited_at IS NULL;
