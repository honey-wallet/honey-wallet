-- Thesis runs, for each person's history (src/thesis/history.rs). One row per run, written
-- when the run starts and updated when it ends. `run` is the whole run document (progress,
-- feed, artifacts, proposal) so an old run can be shown after Redis has expired it (24 h).
-- Rows are kept for at least 90 days; deleting the account deletes them.
CREATE TABLE thesis_runs (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idea text NOT NULL CHECK (char_length(idea) <= 4000),
    stage text NOT NULL CHECK (stage IN ('intake', 'understand', 'strategize', 'done', 'failed')),
    theme text NULL CHECK (theme IS NULL OR char_length(theme) <= 200),
    -- [{"symbol": "ETH", "weightPct": 34}, ...] for the risk level the person asked for.
    picks jsonb NULL CHECK (picks IS NULL OR jsonb_typeof(picks) = 'array'),
    run jsonb NOT NULL CHECK (jsonb_typeof(run) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX thesis_runs_user_idx ON thesis_runs (user_id, created_at DESC, id DESC);
