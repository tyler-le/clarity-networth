ALTER TABLE dependency_events
  DROP CONSTRAINT IF EXISTS dependency_events_outcome_check;

ALTER TABLE dependency_events
  ADD CONSTRAINT dependency_events_outcome_check
  CHECK (outcome IN ('success', 'failure', 'client_error', 'server_error'));
