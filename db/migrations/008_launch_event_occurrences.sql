-- Product usage reporting needs one durable occurrence per accepted tab/card
-- event. The previous daily member index prevented a raw total-use count;
-- unique-member metrics remain available through COUNT(DISTINCT user_key).
DROP INDEX IF EXISTS launch_events_daily_member_event_idx;
