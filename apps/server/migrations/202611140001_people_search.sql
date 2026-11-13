-- People search (GET /social/people): case-insensitive prefix matches on handle and
-- display name. Handles are stored lowercase (see the CHECK on social_profiles), so the
-- handle index needs no lower(). text_pattern_ops lets `LIKE 'abc%'` use a btree under
-- any collation. Matching a later word of a name ('% abc%') scans; the table is small.
CREATE INDEX social_profiles_handle_prefix_idx ON social_profiles (handle text_pattern_ops);
CREATE INDEX social_profiles_name_prefix_idx
    ON social_profiles (lower(display_name) text_pattern_ops);
