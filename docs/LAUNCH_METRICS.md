# Private launch measurement

Clarity has no customer-facing analytics dashboard, analytics card, navigation item, or profile setting. Financial data remains separate from launch measurement.

## Where to look

- Use **Railway Observability** for service health: deployments, logs, CPU, memory, network, restarts, and `/api/health` failures.
- Use the private `launch_events` table for product health. Connect a **separate, private, read-only reporting tool or Railway service** to Postgres if visual charts are useful. Do not add that report to the Clarity web service or expose it publicly.

The owner dashboard uses one selectable reporting window for product metrics (rather than duplicating 7- and 28-day versions of every chart). Sync health remains a separate last-24-hours operational check: it answers whether today's automatic updates are working, not how a product feature is trending.

Railway's built-in dashboard is the correct home for infrastructure monitoring. It does not create product-retention charts from application data by itself.

## Dashboard organization

Use the single, full-width **Clarity Health** dashboard. Product adoption and engagement sit first, with a selectable reporting window for activation, return visits, tab use, core-card views, and meaningful actions. The operational section below shows the last 24 hours of grouped Clarity API, Plaid, Google sign-in, and market-data status and latency. Railway remains the source for host CPU, memory, restarts, and edge availability. Operational events retain no customer identifier or financial content and expire after 30 days.

Do not combine these into an in-app analytics surface or grant the reporting service access to encrypted financial stores.

## What is collected

One opaque account key and one allowlisted event name are retained at most once per account per event per day. A valid authenticated dashboard visit establishes a signed-in member, so people with an existing persistent session are counted without needing to sign out and back in. Demo opens are anonymous counts. Events contain no balances, transactions, merchant names, account names, financial inputs, routes, device fingerprinting, raw IP address, or click replay.

Events are retained for 90 days and are removed when the corresponding account is deleted.

## Launch questions this answers

| Question | Signal |
| --- | --- |
| Are people returning? | Daily dashboard opens; 7- and 28-day cohort retention |
| Are people reaching value? | Account-link completion after sign-in; successful daily sync |
| What needs work? | Sync failure rate; holding-reconciliation starts; debt-plan opens |
| Which experiences earn attention? | Unique daily users opening tabs, seeing a core card, or taking a meaningful card action |
| Is the public demo effective? | Anonymous demo-open count |

Core-card views are recorded only after the card has been at least 50% visible for 750ms; they are distinct from actions such as filtering, expanding, or opening a card. Treat browser events as a conservative lower bound: they are intentionally non-blocking and may be lost if a browser closes or a connection drops. Server-recorded sign-in, dashboard, link, and sync events are the source of truth for activation and retention.

## Minimum private report

Review weekly during beta:

1. Signed-in members and account-link activation rate.
2. 7- and 28-day returning-member cohorts.
3. Successful sync coverage in the last 26 hours and failure rate.
4. Core-card views and meaningful card actions by unique member, not raw clicks. Compare a card's views with its action rate before deciding whether it earns its place.
5. Demo opens and demo-to-sign-in conversion where the same person later authenticates.

Only add a third-party analytics product after a privacy, security, cost, and data-processing review. A separate read-only reporting service is preferable to giving any dashboard access to the Clarity application or its encrypted financial-store data.
