# Clarity

A small, responsive Plaid-powered personal finance app for:

- Net worth tracking across cash, investments, credit cards, and loans
- Monthly expense tracking
- A configurable conscious spending plan
- A Sankey-style income → spending flow visualization
- Manual transaction recategorization and exclusion
- Daily net-worth snapshots with a mouse/touch scrubbable history chart
- Lean, Coast, and Fat FIRE estimates based on tracked living spend
- Plaid Transactions sync with investment/liability consent

The UI is intentionally minimal and mobile-friendly. It can also be installed as a basic PWA from a supporting browser.

## Run it

Requirements: Node.js 20+

```bash
cp .env.example .env
npm install
npm start
```

Open http://localhost:3000

By default, `DEMO_MODE=true`, so the dashboard opens with realistic sample data before Plaid is configured.

## Connect Plaid Sandbox

1. Create a Plaid developer account and get your Sandbox client ID and secret.
2. Add them to `.env`:

```env
PLAID_ENV=sandbox
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_sandbox_secret
MARKETDATA_API_TOKEN=your_market_data_bearer_token
ENCRYPTION_KEY=use-a-long-random-secret-here
```

3. Restart the server.
4. Click **Connect account**.
5. Use Plaid Sandbox credentials, such as `user_good` / `pass_good` where supported by the Sandbox institution.

The app initializes Link with `transactions`, requests consent for `investments` and `liabilities`, exchanges the public token server-side, refreshes accounts, and uses `/transactions/sync` for incremental transaction ingestion.

## Data behavior

### Net worth

- `depository` and `investment` accounts are counted as assets and displayed as positive/green balances.
- `credit` and `loan` accounts are counted as liabilities and displayed as negative/red balances.
- Accounts are grouped into Cash, Savings, Investments, Credit Cards, and Loans/Debt.
- Net worth = assets − liabilities.
- One current snapshot is stored per calendar day.

### FIRE estimates

The dashboard annualizes tracked **fixed + guilt-free** living expenses and compares the current net worth against three editable targets:

- **Lean FIRE:** defaults to 70% of current living spend divided by a 4% withdrawal rate.
- **Coast FIRE:** the amount needed today to grow to a standard FIRE target by retirement age, defaulting to age 65 and a 5% real return.
- **Fat FIRE:** defaults to 150% of current living spend divided by a 4% withdrawal rate.

These are planning estimates rather than universal FIRE definitions. Age, retirement age, withdrawal rate, real return, and Lean/Fat spending multipliers are editable in the UI.

### Transaction signs

Plaid transaction amounts are generally positive for money leaving an account and negative for money entering it. The app normalizes this into spending/income views.

### Conscious spending buckets

The default targets are:

- Fixed costs: 50%
- Savings: 10%
- Investments: 10%
- Guilt-free: 30%

First-pass classification uses Plaid Personal Finance Categories and simple deterministic rules. Users can override any transaction bucket.

Credit card payments and ordinary transfers are excluded from spending by default to avoid double-counting purchases.

## Files

```text
server.js            Express routes + Plaid orchestration
plaid.js             Thin Plaid API client
finance.js           Net worth + transaction classification logic
store.js             JSON persistence + AES-256-GCM token encryption
public/index.html    App shell
public/app.js         Dashboard interactions + charts
public/styles.css    Responsive UI
```

## Important MVP limitations

This is a single-user local MVP, not a production-ready financial application. Before deploying publicly, add:

- Authentication and per-user authorization
- A production database such as Postgres
- Managed secret storage / KMS-backed encryption
- CSRF protection, stricter headers, request validation, audit logging, and rate limiting
- A public HTTPS webhook endpoint and robust background webhook processing
- Plaid Production approval and any required institution/product approvals
- Account deletion/disconnection controls (`/item/remove`)
- Institution relink/update-mode flows for broken credentials
- Better transfer matching between source and destination accounts
- Recurring-bill logic and merchant-specific categorization rules
- Tests and monitoring

## Plaid notes

Plaid currently recommends `/transactions/sync` for new transaction integrations. For personal finance use cases combining Transactions with Investments/Liabilities, Plaid's current guidance is to initialize Transactions and collect consent for the additional products, then call the applicable product endpoints based on the connected account types.
