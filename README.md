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
server.js / finance.js       API, Plaid orchestration, calculations
database.js / store.js       Per-user encrypted financial persistence
secure-payload.js            Payload encryption helpers
public/                      Responsive PWA shell, interactions, charts
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
```

Add `PLAID_CLIENT_ID`, `PLAID_SECRET`, and `PLAID_ENV` only when connecting
Plaid. Keep every secret in your host’s environment-variable manager, never in
Git.

## Tests and releases

Run the full local release gate before a push:

```bash
npm run test:ci
```

This checks syntax, unit tests, integration/security contracts, and Playwright
journeys at phone, tablet, laptop, and desktop breakpoints. A push runs the
same verification in GitHub Actions, deploys to staging, verifies it, then
promotes to production.

See [`AGENTS.md`](AGENTS.md) for the product, accessibility, financial-data,
testing, and UX standards that guide changes.

## Documentation

- [PWA installation guide for beta users](docs/PWA_INSTALL.md)
- [Private beta launch checklist](docs/BETA_LAUNCH.md)
- [Operations and recovery notes](docs/operations.md)

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
