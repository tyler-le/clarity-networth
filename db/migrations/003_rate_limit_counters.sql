-- Opaque, bounded counters for cost-sensitive provider actions. Subject keys
-- are one-way hashes; no raw IP addresses or email addresses are retained.
CREATE TABLE rate_limit_counters (
  scope text NOT NULL,
  subject_key char(64) NOT NULL,
  window_started timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (scope, subject_key, window_started),
  CHECK (subject_key ~ '^[a-f0-9]{64}$')
);

CREATE INDEX rate_limit_counters_window_idx ON rate_limit_counters (window_started);
