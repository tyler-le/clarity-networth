-- Operational dependency telemetry. It identifies only the service operation,
-- outcome, status, and duration so owners can diagnose reliability without
-- retaining customer financial data, credentials, or request payloads.
CREATE TABLE dependency_events (
  id uuid PRIMARY KEY,
  dependency text NOT NULL,
  operation text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  status_code integer,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  event_date date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (dependency ~ '^[a-z0-9_]{1,40}$'),
  CHECK (operation ~ '^[a-z0-9_]{1,80}$')
);

CREATE INDEX dependency_events_created_idx ON dependency_events (created_at DESC);
CREATE INDEX dependency_events_service_idx ON dependency_events (dependency, operation, created_at DESC);
