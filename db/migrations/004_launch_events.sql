-- Privacy-preserving launch telemetry. Event names are allowlisted in the
-- application; this table deliberately contains no financial values, account
-- names, merchants, emails, IP addresses, or browser replay data.
CREATE TABLE launch_events (
  id uuid PRIMARY KEY,
  user_key char(64),
  event_name text NOT NULL,
  event_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (user_key IS NULL OR user_key ~ '^[a-f0-9]{64}$')
);

-- A member can count once per event per day. This avoids turning normal use
-- into clickstream surveillance while still supporting activation and
-- retention metrics.
CREATE UNIQUE INDEX launch_events_daily_member_event_idx
  ON launch_events (user_key, event_name, event_date)
  WHERE user_key IS NOT NULL;

CREATE INDEX launch_events_name_created_idx ON launch_events (event_name, created_at DESC);
CREATE INDEX launch_events_user_created_idx ON launch_events (user_key, created_at DESC)
  WHERE user_key IS NOT NULL;
