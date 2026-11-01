# Clarity

Clarity is a calm, beginner-friendly personal-finance PWA. It gives someone a
fast answer to three questions: **where do I stand, where is my money going,
and what deserves attention next?**

It is intentionally a focused financial picture—not a dense spreadsheet or a
household-budgeting suite. People can explore a full demo without signing in;
personal accounts are private to each signed-in user.

## What it includes

- **Net worth:** verified daily snapshots, scrubbable history, assets, and debt
- **Cash flow:** take-home income, spending categories, saving, investing, and
  interactive transactions without double-counting card payments or transfers
- **Accounts:** cash, savings, investments, liabilities, duplicate detection,
  nicknames, manual items, unlinking, and a calm optional debt-payoff plan
- **Investments:** portfolio value history, allocation, holdings, account
  context, and user corrections for incomplete provider classifications
- **Retirement:** plain-language milestones, Coast independence, retirement
  spending paths based on a person’s own activity, and live plan assumptions
- **Goals and check-ins:** one useful next step, rather than another dashboard
- **Public demo and installable PWA:** seven years of representative demo data,
  dark mode, responsive layouts, and no app-store download required

## Architecture

Clarity is intentionally lean: Node.js/Express serves a dependency-light
HTML/CSS/JavaScript PWA. Financial data stays server-side in per-user,
encrypted stores backed by Postgres in production. Browser responses are
private and non-cacheable; Plaid access tokens never reach the client.

```text
src/server.js                API composition, auth, and Plaid orchestration
src/lib/                     Financial calculations, persistence, providers,
                            encryption, and domain utilities
public/                      Responsive PWA shell, interactions, charts
db/migrations/               Versioned Postgres schema changes
scripts/                     Explicit maintenance and migration commands
test/                        Unit, integration, and Playwright UI journeys
```

## Run locally

Requirements: Node.js 20 or newer.

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). Local development uses a
public demo by default; Plaid is optional until you configure it.

### Local configuration

Use [`.env.example`](.env.example) as the canonical variable list. The values
needed for a production-like deployment are:

```env
NODE_ENV=production
DEMO_MODE=false
DATABASE_URL=postgres-connection-url
DATA_ENCRYPTION_KEY=unique-long-random-secret
SESSION_SECRET=different-unique-long-random-secret
GOOGLE_CLIENT_ID=google-oauth-web-client-id
INVITE_CODE=private-beta-code
SUPPORT_EMAIL=support@example.com
FREEMIUM_ENABLED=false
```

Add `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` only when connecting
Plaid. Keep every secret in your host’s environment-variable manager, never in
Git.

## Tests and releases

Run the full local release gate before a push:

```bash
npm run test:ci
```

The release gate intentionally focuses on financial/data correctness: syntax
checks, unit tests, and integration tests. Browser-flow checks remain available
when a UI change needs them:

```bash
npm run test:ui
```

UI tests are not part of the production promotion gate because copy, layout,
and responsive presentation changes should not block releases when the
canonical data and API behavior remain correct.

The required data suite still exercises failure behavior, not just happy-path
totals. It covers provider/dependency errors and safe customer messages,
rate-limit recovery, pending and ambiguous transactions, refunds and transfer
reconciliation, incomplete or stale history, missing account data, duplicate
provider records, protected writes, and authenticated API failure responses.
When changing a financial rule or dependency boundary, add a focused fixture
for the failure mode and assert the safe result (for example, an unavailable
state or an actionable recovery code) rather than relying on a browser flow.

The optional browser suite covers journeys at phone, tablet, laptop, and
desktop breakpoints. Development runs locally to avoid the cost of a hosted
staging environment. Pushing `dev` does not deploy anything. Production
promotion is manual through `deploy-to-prod`, which runs `npm run test:ci`
against the exact development commit before deployment and smoke checks afterward.

See [`AGENTS.md`](AGENTS.md) for the product, accessibility, financial-data,
testing, and UX standards that guide changes.

## Documentation

- [PWA installation guide for beta users](docs/PWA_INSTALL.md)
- [Private beta launch checklist](docs/BETA_LAUNCH.md)
- [Private launch measurement](docs/LAUNCH_METRICS.md)
- [Operations and recovery notes](docs/operations.md)

## Private health dashboard

This owner-only dashboard lives in a separate, password-protected Metabase service—not in the Clarity customer app:

- [Clarity Health](https://clarity-insights-production.up.railway.app/dashboard/2): product adoption and engagement appear first, followed by the last 24 hours of grouped Clarity API, Plaid, Google sign-in, and market-data status and latency. It reads only minimal operational and product-event tables—never encrypted financial stores or financial values.

## Data principles

- Net worth is assets minus liabilities; debt is always visually distinct.
- Plaid transactions are categorized conservatively, and people can override
  a category or a holding classification when a provider sends incomplete data.
- Card payments and transfers are excluded from cash-flow spending to prevent
  double counting.
- Financial estimates state their assumptions and do not invent history or
  performance when provider data is insufficient.

## Install Clarity

Clarity can be installed from a supporting browser without the App Store or
Play Store. See the [visual installation guide](docs/PWA_INSTALL.md) for
iPhone/iPad, Android, and desktop steps.
