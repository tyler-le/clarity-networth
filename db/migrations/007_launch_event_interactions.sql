-- Keep the interaction count available for historical rows created before
-- migration 008. New rows are written one per occurrence after that
-- migration, so SUM(interaction_count) remains the durable total-use metric.
ALTER TABLE launch_events
  ADD COLUMN IF NOT EXISTS interaction_count integer NOT NULL DEFAULT 1;

ALTER TABLE launch_events
  ADD CONSTRAINT launch_events_interaction_count_positive
  CHECK (interaction_count > 0);
