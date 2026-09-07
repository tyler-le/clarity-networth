# Private launch measurement

Clarity has no customer-facing analytics dashboard, analytics card, navigation item, or profile setting. Financial data remains separate from launch measurement.

## Where to look

- Use **Railway Observability** for service health: deployments, logs, CPU, memory, network, restarts, and `/api/health` failures.
- Use the private `launch_events` table for product health. Connect a **separate, private, read-only reporting tool or Railway service** to Postgres if visual charts are useful. Do not add that report to the Clarity web service or expose it publicly.

Railway's built-in dashboard is the correct home for infrastructure monitoring. It does not create product-retention charts from application data by itself.

## What is collected

One opaque account key and one allowlisted event name are retained at most once per account per event per day. Demo opens are anonymous counts. Events contain no balances, transactions, merchant names, account names, financial inputs, routes, device fingerprinting, raw IP address, or click replay.

Events are retained for 90 days and are removed when the corresponding account is deleted.

## Launch questions this answers

| Question | Signal |
| --- | --- |
| Are people returning? | Daily dashboard opens; 7- and 28-day cohort retention |
| Are people reaching value? | Account-link completion after sign-in; successful daily sync |
| What needs work? | Sync failure rate; holding-reconciliation starts; debt-plan opens |
| Which experiences earn attention? | Unique daily users opening tabs or taking meaningful card actions |
| Is the public demo effective? | Anonymous demo-open count |

Treat browser interaction events as a conservative lower bound: they are intentionally non-blocking and may be lost if a browser closes or a connection drops. Server-recorded sign-in, dashboard, link, and sync events are the source of truth for activation and retention.

## Minimum private report

Review weekly during beta:

1. Signed-in members and account-link activation rate.
2. 7- and 28-day returning-member cohorts.
3. Successful sync coverage in the last 26 hours and failure rate.
4. Meaningful card actions by unique member, not raw clicks.
5. Demo opens and demo-to-sign-in conversion where the same person later authenticates.

Only add a third-party analytics product after a privacy, security, cost, and data-processing review. A separate read-only reporting service is preferable to giving any dashboard access to the Clarity application or its encrypted financial-store data.
