-- Keep launch measurement privacy-preserving while retaining aggregate
-- interaction volume. A row remains one member/event/day; the counter records
-- repeated use without storing a clickstream or event-level timestamps.
ALTER TABLE launch_events
  ADD COLUMN IF NOT EXISTS interaction_count integer NOT NULL DEFAULT 1;

ALTER TABLE launch_events
  ADD CONSTRAINT launch_events_interaction_count_positive
  CHECK (interaction_count > 0);
