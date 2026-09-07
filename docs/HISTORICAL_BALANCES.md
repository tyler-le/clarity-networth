# Historical investments and net worth

Investigated September 7, 2026. This is a prelaunch, single-user app. The goal
is useful, defensible coverage, not a promised percentage of accuracy.

## Feasibility

Yes, for supported accounts and the periods their available records cover.
Historical values reconstructed by Clarity are estimates. A completed API
download means all **available** records were fetched; it does not certify
that the institution supplied every historical event. Matching today's value
is a consistency check, not an independent validation of earlier values.

| Surface | Feasible approach | Limit |
| --- | --- | --- |
| Investment account | Reverse reported share and cash movements from current holdings; value each historical holding using its actual market price | Exact symbols, usable prices, coherent cash and share activity required |
| Portfolio Value | Sum investment account histories on common dates | Every visible investment account must have coverage |
| Checking and savings | Reverse posted debits and credits from the balance returned with transaction sync | Incomplete activity or inconsistent balance checkpoints prevents reconstruction |
| Credit cards | Reverse charges and payments using the opposite balance sign from a deposit account | Pending charges excluded; credit balances and inconsistent checkpoints are withheld |
| Net Worth | Add supported assets and subtract supported debts on common dates | No partial total presented as complete net worth |
| Loans, property, manual accounts, unsupported investments | Institution statements or explicit historical balances would be needed | No assumption that today's balance existed in the past |

## What Plaid provides

Investments supplies current holdings and up to 24 months of investment
transactions. It does not supply a historical daily portfolio valuation
series through those endpoints. Transactions have signed quantities and cash
amounts; canceled records, settlement dates, and combined contribution/purchase
events need special care. See [Plaid Investments overview](https://plaid.com/docs/investments/)
and [Investments API](https://plaid.com/docs/api/products/investments/).

Ordinary Transactions can provide up to 24 months. The requested window must
be set when the product is initialized, and institution coverage can be
shorter. `HISTORICAL_UPDATE_COMPLETE` signals completion of available history.
New Clarity links now request 730 days; existing links cannot gain additional
history simply by changing that field after initialization. See
[Transactions overview](https://plaid.com/docs/transactions/) and
[Transactions API](https://plaid.com/docs/api/products/transactions/).

Plaid Assets is another possible source of **calculated** historical balances,
but its `historical_balances` field applies to credit and depository accounts,
not investments or loans. Its report window can reach 731 days. Adding it to
existing Items requires an Assets consent flow. It is therefore neither an
independent statement-based check nor a universal net-worth solution. It was
not enabled for this change. See [Assets API](https://plaid.com/docs/api/products/assets/)
and [adding Assets to existing Items](https://plaid.com/docs/assets/).

## Other data providers

| Provider | Finding | Decision |
| --- | --- | --- |
| Market Data | Already integrated. Free plan advertises 100 daily credits and one year of historical stock/fund data; core plans are internal-use, and commercial redistribution has a separate plan | Keep the integration for internal validation; confirm derived-data/display rights before launch |
| Twelve Data | Historical/EOD data and development access are available; business use and display rights depend on plan and market | Plausible alternative, but it cannot fill missing personal transactions or identify an unnamed plan fund |
| Alpha Vantage | Supplies historical prices; commercial use requires contacting the provider | Another price source, not a solution for missing account history |
| Another account aggregator | Would require another integration and account connection | No documented universal historical balance guarantee was established; switching does not by itself solve the problem |

Sources: [Market Data pricing](https://www.marketdata.app/pricing/),
[Twelve Data usage guidance](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage),
[Twelve Data business pricing](https://twelvedata.com/pricing-business),
[Alpha Vantage documentation](https://www.alphavantage.co/documentation/),
[Alpha Vantage terms](https://www.alphavantage.co/terms_of_service/),
[SnapTrade account data](https://docs.snaptrade.com/docs/account-data).

## Problems found in the existing implementation

These are code findings, not provider guarantees:

- Reconstruction already existed, but required evidence of the opening
  purchase for every holding. Long-held positions commonly failed that check.
- Account detail stopped attempting reconstruction after two observed updates,
  making older history disappear as tracking accumulated.
- Account reconstruction omitted cash movements from ordinary trades. A sale
  could reduce the plotted account value even if its proceeds stayed inside it.
- The code guessed retail Vanguard fund tickers from target-year display
  labels. A retirement-plan trust is not necessarily the retail share class.
- Prices could be carried forward without an age limit. The stock-price
  request also used provider adjustment defaults, which are unsuitable for
  contemporaneous share quantities.
- Investment pages were applied incrementally, and cancellation metadata was
  discarded. A failed download could leave partial or obsolete activity.
- Net worth had no supported backfill path; legacy estimates were removed.

## Implemented rules

`src/lib/history.js` contains pure calculations; network and persistence stay
in the existing sync workflow.

Investment downloads are paginated completely before replacing their stored
window. Cancellations are resolved across pages. The ledger must correspond
to the holdings refresh. Currency and original ticker evidence are retained;
old records without it wait for a successful sync. Existing ordinary
Transactions cursors are replayed once to retain the new evidence while
preserving user categorization.

An investment's historical quantity is current quantity minus subsequent
signed quantity changes. Cash is current reported cash plus subsequent cash
debits, including trades; fees are not added a second time to Plaid's complete
transaction amount. Sold securities are included. Reinvestment requires
explicit funding evidence or an explicitly zero cash amount. Unsupported
corporate actions and ambiguous activity shorten the timeline to after the
event instead of being silently interpreted.

Explicit combined contributions with positive share quantity and a positive
purchase amount add shares without inventing a separate cash movement. A
negative or otherwise ambiguous contribution/share combination is withheld.

Only supported USD equities, ETFs, mutual funds with exact provider symbols,
and reported dollar cash are eligible. Account totals must reconcile to
reported holdings. A missing holding is not assumed to be cash. Market prices
are cached as unadjusted prices, separately marked from legacy caches.
[Market Data's stock endpoint](https://www.marketdata.app/docs/api/stocks/candles/)
documents why both split and dividend adjustments must be disabled.

Price gaps over seven calendar days, negative reconstructed quantities or cash,
and mismatches against observed account balances prevent extending further.
Available observed checkpoints provide an independent check; they do not
prove accuracy outside the observed period. Oldest returned activity limits
coverage—we do not infer that an account existed before that date.

Net worth requires coverage for every currently visible account. Transfers
and transactions excluded from spending still affect balances. Loan principal
is not derived from payment amounts. Unsupported accounts prevent a complete
historical total, but individually supported investment charts still work.

Derived history is labeled in the chart context, selected-date text, and
investment detail explanation. Once saved tracking starts, saved values and
their actual dates take precedence. The account-detail x-axis uses elapsed
time, including gaps. Demo data remains explicitly synthetic.

## Validation and practical limits

Automated fixtures cover purchases, sales with retained cash, long-held
positions, dividends/reinvestment, cancellations and pagination, missing
symbols/prices/currencies, stale or inconsistent evidence, account isolation,
credit/deposit sign conventions, internal transfers, and complete versus
partial net-worth totals. Browser interactions cover all four supported
device projects.

For actual accuracy validation, compare reconstructed month-end account values
with institution statements at several dates across 12–24 months. Record
dollar error, relative error for materially nonzero balances, and the fraction
of account-months covered separately. A near-zero net worth makes percentage
error unstable even when component errors are small. Include periods with
contributions, sales and distributions. No empirical accuracy percentage has
been established by synthetic tests.

Set `MARKETDATA_HISTORY_YEARS=1` for the existing one-year price window, or `2`
when the provider entitlement supports it. Cash and credit history can reach
24 months independently. Missing market credentials only prevent the
price-dependent histories. A normal successful sync refreshes the evidence
for previously linked accounts; reconnecting is not needed for the new
calculation itself.

Daily balances can differ from a brokerage display around settlement, pending
activity, market-close timing, and institution delays. Use this as a labeled
historical value estimate, not audited performance, tax accounting, or a
promised reconstruction of accounts that are no longer connected.
