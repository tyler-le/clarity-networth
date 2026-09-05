CREATE TABLE financial_stores (
  user_key char(64) PRIMARY KEY,
  payload jsonb NOT NULL,
  source_hash char(64) NOT NULL,
  source_updated_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_key ~ '^[a-f0-9]{64}$')
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  user_key char(64),
  event_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_key IS NULL OR user_key ~ '^[a-f0-9]{64}$')
);

CREATE INDEX audit_events_user_created_at_idx ON audit_events (user_key, created_at DESC);
