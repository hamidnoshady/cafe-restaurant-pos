CREATE TABLE rate_limits (
    key text PRIMARY KEY,
    count integer NOT NULL,
    window_start timestamptz NOT NULL
);
