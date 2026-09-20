
function providerTransferDestinationBucket(tx) {
  const detailed = (tx.personal_finance_category?.detailed || tx.pfc_detailed || '').toUpperCase();
  // A card payment settles purchases which are already present on the card;
  // it must never become an investment merely because its description shares
  // an institution name with a brokerage account.
  if (detailed.includes('CREDIT_CARD_PAYMENT')) return null;
  if (detailed.includes('INVESTMENT') || detailed.includes('RETIREMENT')) return 'investments';
  if (detailed.includes('SAVINGS')) return 'savings';
  return null;
}

function isProviderTransfer(tx) {
  const primary = (tx.personal_finance_category?.primary || tx.pfc_primary || '').toUpperCase();
  const detailed = (tx.personal_finance_category?.detailed || tx.pfc_detailed || '').toUpperCase();
  const name = `${tx.merchant_name || ''} ${tx.name || ''}`.toUpperCase();
  const transactionCode = String(tx.transaction_code || '').toLowerCase();
  return transactionCode === 'transfer' || primary.includes('TRANSFER') || detailed.includes('TRANSFER') || detailed.includes('CREDIT_CARD_PAYMENT') || name.includes('PAYMENT THANK YOU') || name.includes('AUTOPAY PAYMENT');
}

function inflowClassification(tx) {
  const primary = (tx.personal_finance_category?.primary || tx.pfc_primary || '').toUpperCase();
  const detailed = (tx.personal_finance_category?.detailed || tx.pfc_detailed || '').toUpperCase();
  const name = `${tx.merchant_name || ''} ${tx.name || ''}`.toUpperCase();
  const context = `${primary} ${detailed} ${name}`;
  if (/REFUND|REIMBURSE|RETURN|MERCHANT_CREDIT|CREDIT_RECEIVED/.test(context)) return 'refund';
  if (/INVESTMENT.*(SALE|PROCEED)|SECURITIES?_SOLD|STOCK_SALE|SALE_PROCEEDS|BROKERAGE.*(SALE|SOLD)|\bSELL\b/.test(context)) return 'investment_proceeds';
  if (/LOAN|CASH_ADVANCE|LINE_OF_CREDIT|HELOC/.test(context)) return 'loan_proceeds';
  if (primary === 'INCOME' || detailed.startsWith('INCOME_') || /PAYROLL|SALARY|WAGE|EMPLOYER|BONUS|SEVERANCE|PAYOUT|FREELANCE|CONTRACT|BUSINESS|GIG|BENEFIT|UNEMPLOYMENT|SOCIAL_SECURITY|PENSION|INTEREST|DIVIDEND/.test(context)) return 'income';
  return 'ambiguous';
}

function isConfirmedIncome(tx) {
  return inflowClassification(tx) === 'income' || (tx.category_overridden && tx.bucket === 'income');
}

// Cash flow is a signed, posted ledger. A category describes the purpose of a
// transaction; it does not decide whether money entered or left a person's
// accounts. Keep the two concepts separate so a provider category correction
// cannot turn an employer credit into a shopping transaction.
export function cashFlowType(tx) {
  // Investment-ledger rows are only payroll contributions when the provider
  // gives contribution/deferral evidence. A rollover, sale, rebalance, or
  // ordinary investment-account movement must remain investment activity.
  const investmentText = `${tx.merchant_name || ''} ${tx.name || ''} ${tx.pfc_primary || ''} ${tx.pfc_detailed || ''}`.toUpperCase();
  const isContributionRecord = !/ROLLOVER|REBALANC|SALE|SOLD|DIVIDEND|INTEREST/.test(investmentText)
    && /CONTRIBUT|DEFERRAL|PAYROLL|401\s*\(?K\)?|403\s*\(?B\)?|457\s*\(?B\)?|HSA/.test(investmentText);
  if (tx.source === 'investment_transaction' && tx.bucket === 'investments' && isContributionRecord) return 'pre_tax_retirement';
  if (tx.source === 'investment_transaction' && tx.bucket === 'investments') return 'investment_activity';
  if (isProviderTransfer(tx) || tx.bucket === 'transfer') return 'internal_transfer';
  const amount = Number(tx.amount || 0);
  if (amount < 0) return 'external_inflow';
  if (amount > 0) return 'external_outflow';
  return 'neutral';
}

export function classifyTransaction(tx) {
  const primary = (tx.personal_finance_category?.primary || tx.pfc_primary || '').toUpperCase();
  const detailed = (tx.personal_finance_category?.detailed || tx.pfc_detailed || '').toUpperCase();
  const name = `${tx.merchant_name || ''} ${tx.name || ''}`.toUpperCase();

  // The sync layer may later promote an explicitly identified investment or
  // savings transfer. Classification itself remains a transfer so a card
  // payment or generic withdrawal is never promoted from a name match.
  if (cashFlowType(tx) === 'internal_transfer') return 'transfer';

  // Plaid's merchant/category model can occasionally describe an incoming
  // credit as a purchase category (for example an employer payout labeled as
  // marketplace activity). Once a provider-identified transfer is ruled out,
  // the transaction direction is the durable cash-flow fact: money entering
  // an account is an inflow, not discretionary spending. This also makes
  // refunds and credits reconcile rather than silently disappearing.
  if (cashFlowType(tx) === 'external_inflow') return inflowClassification(tx);

  if (detailed.includes('INVESTMENT') || detailed.includes('RETIREMENT')) return 'investments';
  if (detailed.includes('SAVINGS')) return 'savings';

  // Vacation travel is discretionary by default. It is intentionally checked
  // before everyday transport essentials such as gas and public transit.
  if (/TRAVEL|AIRLINE|LODGING|HOTEL|VACATION|CAR_RENTAL|RIDESHARE|TAXI/.test(`${primary} ${detailed} ${name}`)) return 'guilt_free';

  // Fixed costs are recurring or essential obligations—not a generic bucket
  // for all needs. Dining, shopping, entertainment, and ambiguous merchants
  // stay guilt-free unless the user explicitly categorizes them otherwise.
  const fixedHints = [
    'RENT', 'MORTGAGE', 'HOME_IMPROVEMENT', 'UTILITIES', 'ELECTRIC', 'WATER', 'SEWER',
    'INSURANCE', 'GROCER', 'GAS', 'PUBLIC_TRANSIT', 'PARKING', 'TOLL', 'AUTO_PAYMENT',
    'CAR_PAYMENT', 'PHONE', 'INTERNET', 'CABLE', 'LOAN_PAYMENT', 'DEBT_PAYMENT',
    'CHILDCARE', 'DAYCARE', 'MEDICAL', 'PHARMACY'
  ];
  const fixedMerchantHints = [
    'RENT', 'MORTGAGE', 'GEICO', 'STATE FARM', 'PROGRESSIVE', 'VERIZON', 'AT&T',
    'T-MOBILE', 'COMCAST', 'XFINITY', 'SPECTRUM', 'GAS STATION', 'SHELL', 'CHEVRON',
    'COSTCO GAS', 'DAYCARE', 'CHILDCARE'
  ];
  if (fixedHints.some((hint) => primary.includes(hint) || detailed.includes(hint)) || fixedMerchantHints.some((hint) => name.includes(hint))) return 'fixed';

  return 'guilt_free';
}

// Earlier versions inferred a transfer destination from institution words in
// its description. That is unsafe: a card issuer and brokerage can share a
// brand, and a card payment would then be counted a second time as investing.
// Repair only records with no member override and only when Plaid's explicit
// transfer category proves the saved bucket cannot be right.
export function repairTransferClassifications(store) {
  let repaired = 0;
  for (const transaction of store.transactions || []) {
    if (transaction.category_overridden || transaction.source === 'investment_transaction' || !isProviderTransfer(transaction)) continue;
    const destination = providerTransferDestinationBucket(transaction);
    // Plaid's sign convention is positive for money leaving this account.
    // Only that source-side leg may be presented as saving or investing; the
    // receiving leg is an internal transfer and must never be a second
    // allocation or an income event.
    const expectedBucket = Number(transaction.amount || 0) > 0 && destination ? destination : 'transfer';
    // Older versions could have placed a provider-confirmed transfer in any
    // cash-flow bucket. Reconcile every non-overridden mismatch, not only the
    // investment/savings buckets, so a mislabeled transfer cannot become
    // income or discretionary spending after an app upgrade.
    if (transaction.bucket === expectedBucket) continue;
    transaction.bucket = expectedBucket;
    if (expectedBucket === 'transfer') {
      delete transaction.investment_contribution_amount;
      delete transaction.investment_contribution_account_id;
    }
    repaired += 1;
  }
  return repaired;
}

// Reconcile records saved before inbound direction was made authoritative.
// Preserve explicit member choices and never reinterpret provider-identified
// transfers or investment-ledger entries. This is deliberately narrow: it
// only fixes money entering an account that had been incorrectly assigned to
// an outgoing bucket by a provider category.
export function repairIncomingClassifications(store) {
  let repaired = 0;
  for (const transaction of store.transactions || []) {
    const flowType = cashFlowType(transaction);
    if (transaction.cash_flow_type !== flowType) {
      transaction.cash_flow_type = flowType;
      repaired += 1;
    }
    if (transaction.category_overridden || transaction.source === 'investment_transaction') continue;
    if (flowType !== 'external_inflow' || !isConfirmedIncome(transaction) || transaction.bucket === 'income') continue;
    transaction.bucket = 'income';
    repaired += 1;
  }
  return repaired;
}

export function accountSide(type) {
  if (type === 'credit' || type === 'loan') return 'liability';
  return 'asset';
}

// A debt plan should be an honest next step, not an optimistic payoff
// projection.  Institutions do not always return APRs, so only recommend an
// avalanche target when we have a rate to support it.  Snowball works from a
// balance alone and remains useful for every debt account.
export function debtPayoffPlan(store) {
  const debts = (store.accounts || [])
    .filter((account) => !account.hidden && ['credit', 'loan'].includes(String(account.type || '').toLowerCase()))
    .map((account) => {
      const rate = Number(account.interest_rate);
      return {
        id: account.id,
        name: account.nickname || account.name || 'Unnamed account',
        balance: Math.abs(Number(account.current_balance || 0)),
        interestRate: Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null
      };
    })
    .filter((account) => account.balance > 0);
  const strategy = store.settings?.debt_strategy === 'snowball' ? 'snowball' : 'avalanche';
  const withRates = debts.filter((account) => account.interestRate != null);
  const priority = strategy === 'snowball'
    ? [...debts].sort((a, b) => a.balance - b.balance)[0] || null
    : [...withRates].sort((a, b) => b.interestRate - a.interestRate || a.balance - b.balance)[0] || null;
  return {
    totalDebt: debts.reduce((sum, account) => sum + account.balance, 0),
    accountCount: debts.length,
    strategy,
    priority,
    debts,
    missingRates: debts.filter((account) => account.interestRate == null).length
  };
}

function assetClass(type, override = null) {
  if (override) return override;
  const value = String(type || '').toLowerCase();
  if (value === 'equity') return 'Equities';
  if (value === 'etf' || value === 'mutual fund') return 'Funds';
  if (value === 'fixed income') return 'Fixed income';
  if (value === 'cash') return 'Cash';
  if (value === 'cryptocurrency') return 'Crypto';
  return 'Other';
}

// Portfolio history has three honest states. "Preparing" means Plaid has
// accepted an asynchronous historical-activity request; "tracking" means we
// have a current baseline and will add provider-observed snapshots over time;
// "ready" means a chart has at least two defensible points. This status is
// derived from the stored evidence, never from a guessed start date.
function investmentHistoryStatus(store, accounts) {
  if (!accounts.length) return { state: 'not_applicable' };
  const itemIds = new Set(accounts.map((account) => account.item_id).filter(Boolean));
  if ((store.items || []).some((item) => itemIds.has(item.id) && item.investment_history_state === 'preparing')) {
    return { state: 'preparing' };
  }
  if ((store.investment_snapshots || []).filter((snapshot) => snapshot.source === 'verified').length >= 2) {
    return { state: 'ready' };
  }
  return { state: 'tracking' };
}

export function investmentSummary(store, { range = 'all' } = {}) {
  const accounts = store.accounts.filter((account) => !account.hidden && account.type === 'investment');
  const accountIds = new Set(accounts.map((account) => account.plaid_account_id));
  const providerPositions = (store.positions || []).filter((position) => !position.hidden && accountIds.has(position.account_id));
  // A provider can return an investment account balance without its positions.
  // Manual entries fill only that unexplained balance; reported positions remain
  // intact, so this works the same way across institutions.
  const manualPositions = (store.manual_holdings || [])
    .filter((position) => accountIds.has(position.account_id))
    .map((position) => ({
      ...position,
      type: 'other',
      asset_class_override: position.asset_class,
      quantity: null,
      cost_basis: null,
      manual: true
    }));
  const positions = [...providerPositions, ...manualPositions];
  const total = accounts.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const holdingsValue = positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  const holdingsByAccount = new Map();
  for (const position of positions) holdingsByAccount.set(position.account_id, (holdingsByAccount.get(position.account_id) || 0) + Math.abs(Number(position.value || 0)));
  // This is a reconciliation state, not an asset class. Preserve the account
  // evidence so the UI can explain a residual instead of showing an empty
  // holdings list when a person taps it.
  const unclassifiedAccounts = accounts.map((account) => {
    const value = Math.abs(Number(account.current_balance || 0));
    const holdingsValue = holdingsByAccount.get(account.plaid_account_id) || 0;
    return {
      account_id: account.plaid_account_id,
      name: account.nickname || account.name,
      institution_name: account.institution_name,
      balance: value,
      holdings_value: holdingsValue,
      difference: value - holdingsValue
    };
  }).filter((account) => Math.abs(account.difference) > 1).sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  const allocation = new Map();
  for (const position of positions) {
    const name = assetClass(position.type, position.asset_class_override);
    allocation.set(name, (allocation.get(name) || 0) + Math.abs(Number(position.value || 0)));
  }
  const remaining = Math.max(0, total - holdingsValue);
  if (remaining > 1) allocation.set('Cash & unclassified', (allocation.get('Cash & unclassified') || 0) + remaining);
  const allocationRows = [...allocation.entries()].map(([name, value]) => ({ name, value, share: total ? value / total : 0 })).sort((a, b) => b.value - a.value);
  const portfolioAccountIds = accounts.map((account) => account.plaid_account_id);
  const portfolio = investmentPortfolioSnapshots(store, portfolioAccountIds);
  const progress = investmentPortfolioRangeProgress(store, { range, accountIds: portfolioAccountIds });
  const sharedWindow = progress.state === 'ready' && progress.basis === 'account_snapshots'
    ? { startDate: progress.startDate, endDate: progress.endDate }
    : null;
  return {
    range,
    total,
    // This is the canonical portfolio range result. The client must use its
    // observed endpoints for the headline, chart, and account rows. A legacy
    // aggregate can still show its verified chart, but it cannot safely claim
    // row-level performance until shared account snapshots exist.
    progress,
    accounts: accounts.map((account) => ({
      id: account.id,
      account_id: account.plaid_account_id,
      name: account.nickname || account.name,
      institution_name: account.institution_name,
      subtype: account.subtype,
      value: Math.abs(Number(account.current_balance || 0)),
      rangeProgress: sharedWindow
        ? investmentRangeProgress(store, { accountId: account.plaid_account_id, range, window: sharedWindow })
        : { scope: 'account', range, state: 'tracking', points: 0 }
    })),
    allocation: allocationRows,
    unclassifiedAccounts,
    positions: positions.map((position) => ({ ...position, gain: position.cost_basis == null ? null : Number(position.value || 0) - Number(position.cost_basis), gain_pct: position.cost_basis ? (Number(position.value || 0) - Number(position.cost_basis)) / Number(position.cost_basis) : null, rangeProgress: position.manual || !position.ticker ? null : investmentRangeProgress(store, { ticker: position.ticker, holdingKeys: [positionSnapshotKey(position)], range }) })).sort((a, b) => Number(b.value || 0) - Number(a.value || 0)),
    snapshots: portfolio.snapshots.slice(-3650),
    historyStatus: investmentHistoryStatus(store, accounts),
    positionsAvailable: positions.length > 0
  };
}

// Investment transaction records added by the sync path are normalized
// contributions, while bank-side investment transfers are also deposits. This
// compact activity feed lets the net-worth view distinguish deposits from
// market movement without exposing a full transaction ledger on the dashboard.
export function investmentContributions(store) {
  return (store.transactions || [])
    .filter((transaction) => !transaction.pending && !transaction.excluded && (transaction.bucket === 'investments' || Number(transaction.investment_contribution_amount || 0) > 0))
    .map((transaction) => ({ date: transaction.date, accountId: transaction.investment_contribution_account_id || transaction.account_id, amount: Number(transaction.investment_contribution_amount || transaction.amount || 0) }))
    .filter((transaction) => transaction.amount > 0);
}

export function investmentLinkBalances(store) {
  return (store.investment_link_events || []).map((event) => ({ accountId: event.account_id, date: event.date, amount: Number(event.amount || 0), historicalCoverage: event.historical_coverage === true }));
}

export function snapshotInvestments(store, snapshotDate = new Date().toISOString().slice(0, 10)) {
  const accounts = store.accounts.filter((account) => !account.hidden && account.type === 'investment');
  const value = accounts.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  // Historical presentation uses only observed daily snapshots. Discard any
  // legacy reconstructed rows rather than mixing inferred data into a chart.
  store.investment_snapshots = (store.investment_snapshots || []).filter((snapshot) => snapshot.source === 'verified');
  const existing = store.investment_snapshots.find((snapshot) => snapshot.date === snapshotDate);
  const snapshot = { date: snapshotDate, value, source: 'verified' };
  if (existing) Object.assign(existing, snapshot); else store.investment_snapshots.push(snapshot);
  store.investment_snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (store.investment_snapshots.length > 3650) store.investment_snapshots = store.investment_snapshots.slice(-3650);

  // These are provider-observed values at the time of a Clarity sync. They
  // deliberately do not fill missing dates or derive values from trades and
  // market prices: a personal chart must never imply a past balance Plaid did
  // not report.
  store.investment_position_snapshots ||= [];
  const upsert = (snapshot) => {
    const existingRecord = store.investment_position_snapshots.find((record) => record.date === snapshot.date && record.kind === snapshot.kind && record.key === snapshot.key);
    if (existingRecord) Object.assign(existingRecord, snapshot); else store.investment_position_snapshots.push(snapshot);
  };
  for (const account of accounts) upsert({
    date: snapshotDate, kind: 'account', key: account.plaid_account_id,
    account_id: account.plaid_account_id, account_type: account.type,
    iso_currency_code: account.iso_currency_code || null,
    value: Math.abs(Number(account.current_balance || 0)), source: 'verified'
  });
  for (const position of (store.positions || []).filter((position) => !position.hidden && accounts.some((account) => account.plaid_account_id === position.account_id))) {
    upsert({
      date: snapshotDate, kind: 'holding', key: position.id || `${position.account_id}:${position.security_id || position.ticker || position.name}`,
      account_id: position.account_id,
      // Preserve provider identity and the provider-observed facts that make a
      // later holding comparison meaningful. They are not reconstructed from
      // the current quote, and missing fields remain null rather than guessed.
      security_id: position.security_id || null,
      ticker: String(position.ticker || '').toUpperCase() || null,
      provider_ticker: String(position.provider_ticker || '').toUpperCase() || null,
      quantity: position.quantity != null && Number.isFinite(Number(position.quantity)) ? Number(position.quantity) : null,
      price: position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null,
      price_as_of: position.price_as_of || null,
      security_type: position.type || null,
      iso_currency_code: position.iso_currency_code || null,
      unofficial_currency_code: position.unofficial_currency_code || null,
      value: Math.abs(Number(position.value || 0)), source: 'verified'
    });
  }
  store.investment_position_snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (store.investment_position_snapshots.length > 20_000) store.investment_position_snapshots = store.investment_position_snapshots.slice(-20_000);
}

function positionSnapshotKey(position) {
  return position.id || `${position.account_id}:${position.security_id || position.ticker || position.name}`;
}

function providerPositionHistory(store, { accountId = null, ticker = null, holdingKeys = null } = {}) {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const allowedHoldingKeys = holdingKeys?.length ? new Set(holdingKeys) : null;
  const records = (store.investment_position_snapshots || []).filter((record) => {
    if (record.source !== 'verified') return false;
    if (!(store.accounts || []).some((account) => !account.hidden && account.type === 'investment' && account.plaid_account_id === record.account_id)) return false;
    if (accountId) return record.kind === 'account' && record.account_id === accountId;
    // Ticker text is not a durable personal-position identity: the same fund
    // can exist in several retirement accounts, or be moved between them.
    // A current holding may only use snapshots of that exact provider position.
    return record.kind === 'holding' && record.ticker === normalizedTicker
      && (!allowedHoldingKeys || allowedHoldingKeys.has(record.key));
  });
  const totals = new Map();
  for (const record of records) totals.set(record.date, (totals.get(record.date) || 0) + Number(record.value || 0));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

const investmentRanges = new Set(['1m', '3m', '6m', 'ytd', '1y', 'all']);

function investmentRangeStart(endDate, range) {
  if (range === 'all') return null;
  const end = new Date(`${endDate}T12:00:00Z`);
  const start = new Date(end);
  if (range === '1m') start.setUTCMonth(start.getUTCMonth() - 1);
  else if (range === '3m') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (range === '6m') start.setUTCMonth(start.getUTCMonth() - 6);
  else if (range === 'ytd') start.setUTCMonth(0, 1);
  else if (range === '1y') start.setUTCFullYear(start.getUTCFullYear() - 1);
  return start.toISOString().slice(0, 10);
}

function holdingSnapshotIdentity(record) {
  if (!record?.account_id || !record?.security_id) return null;
  const symbol = String(record.provider_ticker || record.ticker || '').trim().toUpperCase();
  return symbol ? `${record.account_id}:${record.security_id}:${symbol}` : null;
}

function snapshotValue(records) {
  return records.reduce((sum, record) => sum + Math.abs(Number(record.value || 0)), 0);
}

function holdingMarketChange(first, last) {
  const firstByIdentity = new Map(first.map((record) => [holdingSnapshotIdentity(record), record]));
  const lastByIdentity = new Map(last.map((record) => [holdingSnapshotIdentity(record), record]));
  if (!firstByIdentity.size || firstByIdentity.has(null) || lastByIdentity.has(null)
    || firstByIdentity.size !== lastByIdentity.size
    || [...firstByIdentity.keys()].some((identity) => !lastByIdentity.has(identity))) return null;
  let change = 0;
  for (const [identity, opening] of firstByIdentity) {
    const closing = lastByIdentity.get(identity);
    const quantity = Number(opening.quantity);
    const openingPrice = Number(opening.price);
    const closingPrice = Number(closing.price);
    const openingValue = Math.abs(Number(opening.value));
    const closingValue = Math.abs(Number(closing.value));
    if (opening.quantity == null || closing.quantity == null || opening.price == null || closing.price == null
      || !Number.isFinite(quantity) || quantity < 0 || Math.abs(Number(closing.quantity) - quantity) > .000001
      || !Number.isFinite(openingPrice) || openingPrice <= 0 || !Number.isFinite(closingPrice) || closingPrice <= 0
      || Math.abs(openingValue - quantity * openingPrice) > Math.max(1, openingValue * .01)
      || Math.abs(closingValue - quantity * closingPrice) > Math.max(1, closingValue * .01)) return null;
    change += quantity * (closingPrice - openingPrice);
  }
  return Math.round(change * 100) / 100;
}

// A selected investment range can always state the verified balance change.
// It calls that change market performance only for an unchanged, provider-
// identified holding whose quantities and prices reconcile at both endpoints.
// Account-level changes deliberately remain balance changes: deposits,
// withdrawals, and cash movement cannot be separated safely from a balance.
export function investmentRangeProgress(store, { accountId = null, ticker = null, holdingKeys = null, range = 'all', window = null } = {}) {
  const selectedRange = investmentRanges.has(range) ? range : 'all';
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const allowedHoldingKeys = holdingKeys?.length ? new Set(holdingKeys) : null;
  const scope = accountId ? 'account' : 'holding';
  const records = (store.investment_position_snapshots || []).filter((record) => {
    if (record.source !== 'verified') return false;
    if (accountId) return record.kind === 'account' && record.account_id === accountId;
    return record.kind === 'holding' && record.ticker === normalizedTicker
      && (!allowedHoldingKeys || allowedHoldingKeys.has(record.key));
  });
  const endDate = window?.endDate || records.map((record) => record.date).filter(Boolean).sort().at(-1) || null;
  if (!endDate) return { scope, range: selectedRange, state: 'tracking', points: 0, requestedStartDate: null };
  const startDate = window?.startDate || investmentRangeStart(endDate, selectedRange);
  const byDate = new Map();
  for (const record of records) {
    if (!record.date || (startDate && record.date < startDate) || record.date > endDate) continue;
    if (!byDate.has(record.date)) byDate.set(record.date, []);
    byDate.get(record.date).push(record);
  }
  const dates = [...byDate.keys()].sort();
  // Account rows beneath the portfolio are meaningful only when they use the
  // portfolio's exact observed endpoints. Do not silently choose another
  // start or end day for an account with incomplete data.
  if (window && (!byDate.has(startDate) || !byDate.has(endDate))) {
    return { scope, range: selectedRange, state: 'tracking', points: dates.length, trackingSince: dates[0] || null, requestedStartDate: startDate };
  }
  if (dates.length < 2) return {
    scope, range: selectedRange, state: 'tracking', points: dates.length,
    trackingSince: dates[0] || null, requestedStartDate: startDate
  };
  const opening = byDate.get(dates[0]);
  const closing = byDate.get(dates.at(-1));
  const startValue = snapshotValue(opening);
  const endValue = snapshotValue(closing);
  const valueChange = Math.round((endValue - startValue) * 100) / 100;
  const marketChange = scope === 'holding' ? holdingMarketChange(opening, closing) : null;
  return {
    scope, range: selectedRange, state: 'ready', points: dates.length,
    requestedStartDate: startDate, startDate: dates[0], endDate: dates.at(-1), startValue, endValue, valueChange,
    // `null` explicitly means that purchases, sales, transfers, or incomplete
    // provider facts prevent us from calling this investment performance.
    marketChange,
    marketChangePct: marketChange != null && startValue > 0 ? marketChange / startValue : null,
    changeKind: marketChange != null ? 'market' : 'balance'
  };
}

// Connected cash, credit, loan, and provider-defined accounts use the same
// verified-snapshot principle as investment accounts. A balance timeline is
// useful even when an institution cannot provide transactions or liability
// terms; it must never be reverse-engineered from activity.
export function accountBalanceHistory(store, { accountId, range = 'all' } = {}) {
  const selectedRange = investmentRanges.has(range) ? range : 'all';
  const account = (store.accounts || []).find((entry) => entry.plaid_account_id === accountId
    && !entry.hidden && !entry.manual && entry.type !== 'investment');
  if (!account) return null;
  const byDate = new Map();
  for (const snapshot of store.account_balance_snapshots || []) {
    if (snapshot.account_id !== accountId || snapshot.source !== 'verified' || !snapshot.date) continue;
    // A same-day provider refresh replaces the prior observed value.
    byDate.set(snapshot.date, Number(snapshot.value));
  }
  const allHistory = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value, source: 'verified' }));
  const endDate = allHistory.at(-1)?.date || null;
  const requestedStartDate = endDate ? investmentRangeStart(endDate, selectedRange) : null;
  const history = requestedStartDate ? allHistory.filter((row) => row.date >= requestedStartDate) : allHistory;
  const progress = history.length >= 2 ? {
    state: 'ready', range: selectedRange, points: history.length, requestedStartDate,
    startDate: history[0].date, endDate: history.at(-1).date,
    startValue: history[0].value, endValue: history.at(-1).value,
    valueChange: Math.round((history.at(-1).value - history[0].value) * 100) / 100
  } : {
    state: 'tracking', range: selectedRange, points: history.length, requestedStartDate,
    trackingSince: history[0]?.date || null
  };
  const activity = (store.transactions || [])
    .filter((transaction) => transaction.account_id === accountId && !transaction.pending && !transaction.excluded)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 3)
    .map((transaction) => {
      const flowType = cashFlowType(transaction);
      const editable = (flowType === 'external_outflow' && !['savings', 'investments', 'transfer'].includes(transaction.bucket))
        || (flowType === 'external_inflow' && !['refund', 'investment_proceeds', 'loan_proceeds'].includes(inflowClassification(transaction)));
      const category = flowType === 'external_inflow' ? incomeSource(transaction) : cashFlowDetail(transaction);
      return {
        id: transaction.id,
        date: transaction.date,
        name: transaction.merchant_name || transaction.name || 'Transaction',
        amount: Number(transaction.amount || 0),
        editableCategory: editable,
        category: category.label,
        cashFlowCategory: category.key,
        categoryFlow: flowType === 'external_inflow' ? 'income' : 'outflow'
      };
    });
  return {
    state: progress.state,
    account: {
      id: account.plaid_account_id,
      name: account.nickname || account.name || 'Connected account',
      institutionName: account.institution_name || '',
      type: account.type || 'other',
      subtype: account.subtype || '',
      value: Number(account.current_balance || 0),
      interestRate: account.interest_rate != null && Number.isFinite(Number(account.interest_rate)) ? Number(account.interest_rate) : null
    },
    history,
    progress,
    activity,
    categoryOptions: CASH_FLOW_CATEGORY_OPTIONS,
    detail: history.length ? `Based on ${history.length} verified daily update${history.length === 1 ? '' : 's'} from your connected institution.` : undefined,
    reason: 'Daily account tracking will begin with your next verified update.'
  };
}

// Portfolio balances are observed separately from position snapshots. Keep
// their range calculation in the same layer as account and holding progress
// so no view has to invent a second calendar boundary in the browser.
function verifiedPortfolioAccountSnapshots(store, accountIds) {
  const ids = accountIds?.length
    ? accountIds
    : (store.accounts || []).filter((account) => !account.hidden && account.type === 'investment').map((account) => account.plaid_account_id);
  if (!ids.length) return [];
  const wanted = new Set(ids);
  const byDate = new Map();
  for (const record of store.investment_position_snapshots || []) {
    if (record.source !== 'verified' || record.kind !== 'account' || !record.date || !wanted.has(record.account_id)) continue;
    if (!byDate.has(record.date)) byDate.set(record.date, new Map());
    // A retry can create more than one observation on a day; the final one is
    // the daily snapshot and matches the convention used by every chart.
    byDate.get(record.date).set(record.account_id, record);
  }
  return [...byDate.entries()]
    .filter(([, records]) => records.size === wanted.size)
    .map(([date, records]) => ({
      date,
      value: Math.round([...records.values()].reduce((sum, record) => sum + Math.abs(Number(record.value || 0)), 0) * 100) / 100,
      source: 'verified',
      basis: 'account_snapshots'
    }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function investmentPortfolioSnapshots(store, accountIds) {
  const accountSnapshots = verifiedPortfolioAccountSnapshots(store, accountIds);
  if (accountSnapshots.length) return { snapshots: accountSnapshots, basis: 'account_snapshots' };
  // Compatibility for members whose aggregate daily snapshots predate
  // account-level tracking. These cannot reconcile to account rows, so their
  // account performance must stay hidden until common coverage exists.
  return {
    snapshots: (store.investment_snapshots || [])
      .filter((record) => record.source === 'verified' && record.date)
      .sort((left, right) => String(left.date).localeCompare(String(right.date))),
    basis: 'aggregate_snapshots'
  };
}

export function investmentPortfolioRangeProgress(store, { range = 'all', accountIds = null } = {}) {
  const selectedRange = investmentRanges.has(range) ? range : 'all';
  const { snapshots: records, basis } = investmentPortfolioSnapshots(store, accountIds);
  const endDate = records.at(-1)?.date || null;
  if (!endDate) return { scope: 'portfolio', range: selectedRange, state: 'tracking', points: 0, requestedStartDate: null, basis };
  const requestedStart = investmentRangeStart(endDate, selectedRange);
  // A sync can retry within a day. The last observed balance for that day is
  // the one that represents the daily snapshot, matching chart semantics.
  const byDate = new Map();
  for (const record of records) {
    if ((requestedStart && record.date < requestedStart) || record.date > endDate) continue;
    byDate.set(record.date, record);
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) return {
    scope: 'portfolio', range: selectedRange, state: 'tracking', points: dates.length, basis,
    trackingSince: dates[0] || null, requestedStartDate: requestedStart
  };
  const opening = byDate.get(dates[0]);
  const closing = byDate.get(dates.at(-1));
  const startValue = Math.abs(Number(opening.value || 0));
  const endValue = Math.abs(Number(closing.value || 0));
  return {
    scope: 'portfolio', range: selectedRange, state: 'ready', points: dates.length, basis,
    requestedStartDate: requestedStart, startDate: dates[0], endDate: dates.at(-1), startValue, endValue,
    valueChange: Math.round((endValue - startValue) * 100) / 100,
    changeKind: 'balance'
  };
}

// Some institutions send a display label in place of a tradable target-date
// fund ticker. Historical pricing needs a real ticker to build a timeline.
export function historicalTicker(ticker, securityName = '') {
  // A plan trust and a retail fund can share a name/year but have different
  // unit values. Only a provider-supplied symbol establishes the security.
  return String(ticker || '').trim().toUpperCase();
}

export function historicalSecurity({ ticker, name = '', type = 'other' } = {}) {
  return { ticker: historicalTicker(ticker, name), type };
}

function nearestPrice(prices, date) {
  return Object.keys(prices || {}).filter((day) => day <= date).sort().at(-1) ? Number(prices[Object.keys(prices).filter((day) => day <= date).sort().at(-1)]) : null;
}

function transactionMatchesPosition(transaction, position) {
  if (position.account_id && transaction.account_id && position.account_id !== transaction.account_id) return false;
  if (position.security_id && transaction.security_id) return position.security_id === transaction.security_id;
  const transactionTicker = String(transaction.ticker || '').trim().toUpperCase();
  const positionTicker = String(position.ticker || '').trim().toUpperCase();
  return Boolean(transactionTicker && positionTicker && transactionTicker === positionTicker);
}

// An account trend needs to include securities that were sold during the
// selected period, not only today's holdings. We can add such a security only
// when Plaid supplied both a stable security ID and a priced ticker. Anything
// less would quietly understate the earlier account value.
function reportedHistoricalPositions(store, positions, accountId) {
  const historical = [...positions];
  const records = (store.investment_transactions || []).filter((transaction) => transaction.account_id === accountId && Number(transaction.quantity || 0) !== 0);
  // A current investment-cash position can be reconstructed only when its
  // reported ledger identifies that exact security. Other unidentified or
  // historical cash activity would leave an unknown portion of the account,
  // so it remains a hard stop rather than quietly being dropped.
  if (records.some((transaction) => {
    const currentPosition = positions.find((position) => transactionMatchesPosition(transaction, position));
    return !currentPosition && (!transaction.security_id || !transaction.ticker || String(transaction.security_type || '').toLowerCase() === 'cash');
  })) {
    return { positions: historical, reason: 'Your institution did not provide enough priced security detail to verify this account history.' };
  }
  for (const transaction of records) {
    if (historical.some((position) => transactionMatchesPosition(transaction, position))) continue;
    historical.push({
      account_id: accountId,
      security_id: transaction.security_id,
      ticker: String(transaction.ticker).toUpperCase(),
      type: transaction.security_type || 'other',
      quantity: 0,
      value: 0,
      historical_only: true
    });
  }
  return { positions: historical, reason: null };
}

function observedStartDate(positions, transactions, linkEvents = [], { requireReportedTrades = false } = {}) {
  const starts = positions.map((position) => {
    const firstTrade = transactions
      .filter((transaction) => transactionMatchesPosition(transaction, position) && Number.isFinite(Number(transaction.quantity)) && Number(transaction.quantity) !== 0)
      .map((transaction) => transaction.date)
      .filter(Boolean)
      .sort()[0];
    if (firstTrade) return firstTrade;
    // A connection-day balance can establish a current baseline, but it never
    // proves a position’s daily composition. Derived charts therefore require
    // a reported trade; the baseline is retained for verified daily tracking.
    if (requireReportedTrades) return null;
    return linkEvents.find((event) => event.account_id === position.account_id)?.date || null;
  });
  return starts.length && starts.every(Boolean) ? starts.sort().at(-1) : null;
}

export function reconstructInvestmentHistory(store, endDate = new Date().toISOString().slice(0, 10), years = 1) {
  const result = reconstructReportedPositions(store, (store.positions || []).filter((position) => !position.hidden), { endDate, years });
  return result.state === 'ready' ? result.history : [];
}

function reconstructionTolerance(value) {
  // Market closes and the institution's as-of time can differ slightly. This
  // accepts a small, explainable drift but rejects a material missing cash,
  // holding, or activity record.
  return Math.max(25, Math.abs(Number(value || 0)) * .01);
}

function cashLedgerPrice(position) {
  const quantity = Number(position.quantity || 0);
  const value = Number(position.value || 0);
  const institutionPrice = Number(position.price || 0);
  // This is limited to genuine $1 investment cash (not a depository balance,
  // money-market fund with an unknown NAV, or an inferred conversion rate).
  // The ending reconciliation below independently checks the final value.
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(value) || !Number.isFinite(institutionPrice)) return null;
  if (Math.abs(institutionPrice - 1) > .01 || Math.abs(value / quantity - 1) > .01) return null;
  return 1;
}

function reconstructReportedPositions(store, positions, { endDate = new Date().toISOString().slice(0, 10), years = 1, expectedValue = null } = {}) {
  if (!positions.length || positions.some((position) => !position.security_id || !position.ticker || !Number.isFinite(Number(position.quantity)) || Number(position.quantity) < 0 || (position.type === 'cash' && cashLedgerPrice(position) == null))) return { state: 'unavailable', reason: 'Your institution did not provide enough priced holding detail to verify a reconstruction.', history: [] };
  const relevant = (store.investment_transactions || []).filter((transaction) => transaction.date <= endDate && positions.some((position) => transactionMatchesPosition(transaction, position)));
  const tradesByPosition = positions.map((position) => relevant.filter((transaction) => transactionMatchesPosition(transaction, position) && Number.isFinite(Number(transaction.quantity)) && Number(transaction.quantity) !== 0));
  const firstTradeByPosition = tradesByPosition.map((trades) => trades.map((transaction) => transaction.date).filter(Boolean).sort()[0]);
  if (firstTradeByPosition.some((date) => !date)) return { state: 'unavailable', reason: 'Your institution did not provide reported activity for every current holding.', history: [] };
  // A later purchase must not erase a real earlier balance from the same
  // account. Start at the requested window and calculate the reported
  // quantity for every day; empty days are trimmed below. This also means an
  // account opened in January never receives a made-up pre-January balance.
  const start = new Date(`${endDate}T12:00:00`);
  start.setFullYear(start.getFullYear() - Math.max(1, Math.min(2, Number(years) || 1)));
  const startDate = start.toISOString().slice(0, 10);
  // If the first reported trade lands inside the requested period, a
  // non-zero quantity immediately before it would be an unknown opening
  // balance. Do not turn that unknown into a personal history. A complete
  // ledger may establish a new position at zero; otherwise the chart waits
  // for provider-observed snapshots.
  for (let index = 0; index < positions.length; index += 1) {
    const firstTrade = firstTradeByPosition[index];
    if (firstTrade <= startDate) continue;
    const quantityBeforeFirstTrade = Number(positions[index].quantity || 0) - tradesByPosition[index].reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0);
    if (Math.abs(quantityBeforeFirstTrade) > .000001) return { state: 'unavailable', reason: 'Reported activity does not establish this holding’s opening balance for the requested period.', history: [] };
  }
  const history = [];
  for (const cursor = new Date(start); cursor <= new Date(`${endDate}T12:00:00`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    let value = 0;
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index];
      // A reported purchase establishes the first defensible day for this
      // security. Earlier zero/unknown space remains absent rather than being
      // rendered as a made-up balance.
      if (date < firstTradeByPosition[index]) continue;
      const laterQuantity = relevant.filter((transaction) => transactionMatchesPosition(transaction, position) && transaction.date > date).reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0);
      const quantity = Number(position.quantity || 0) - laterQuantity;
      if (!Number.isFinite(quantity) || quantity < -.000001) return { state: 'unavailable', reason: 'Reported activity does not reconcile to the current quantity.', history: [] };
      if (quantity <= .000001) continue;
      const price = position.type === 'cash' ? cashLedgerPrice(position) : nearestPrice(store.market_prices?.[String(position.ticker).toUpperCase()], date);
      if (!Number.isFinite(price)) return { state: 'unavailable', reason: 'A historical price needed to verify this position is unavailable.', history: [] };
      value += quantity * price;
    }
    history.push({ date, value: Math.round(value * 100) / 100, source: 'reconstructed' });
  }
  // Do not make an account appear to have existed before its first reported
  // position. We retain an actual zero only after the history has begun.
  const firstValue = history.findIndex((snapshot) => snapshot.value > .005);
  const visibleHistory = firstValue < 0 ? [] : history.slice(firstValue);
  if (visibleHistory.length < 2) return { state: 'unavailable', reason: 'There is not enough reported activity for a useful personal history.', history: [] };
  const target = Number(expectedValue == null ? positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0) : expectedValue);
  const difference = Math.abs(Number(visibleHistory.at(-1).value || 0) - target);
  if (!Number.isFinite(target) || difference > reconstructionTolerance(target)) return { state: 'unavailable', reason: 'The reconstructed value does not closely match the latest institution value.', history: [] };
  return { state: 'ready', history: visibleHistory, startDate: visibleHistory[0].date, difference };
}

// Remove legacy inferred rows. The product presents only snapshots directly
// observed from a connected institution.
export function refreshReconstructedInvestmentSnapshots(store, endDate = new Date().toISOString().slice(0, 10), years = 1) {
  store.investment_snapshots = (store.investment_snapshots || []).filter((snapshot) => snapshot.source === 'verified');
  return store.investment_snapshots;
}

// Detail charts represent only directly observed personal snapshots. We never
// manufacture a past position from transactions, historical prices, or a
// current balance.
export function investmentDetailHistory(store, { accountId = null, ticker = null, years = 1, range = 'all' } = {}) {
  const selectedAccount = accountId
    ? store.accounts.find((account) => account.plaid_account_id === accountId && !account.hidden && account.type === 'investment')
    : null;
  const visibleAccounts = new Set(store.accounts.filter((account) => !account.hidden && account.type === 'investment').map((account) => account.plaid_account_id));
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const positions = (store.positions || []).filter((position) => {
    if (!visibleAccounts.has(position.account_id) || position.hidden) return false;
    if (accountId) return position.account_id === accountId;
    return normalizedTicker && String(position.ticker || '').trim().toUpperCase() === normalizedTicker;
  });
  const holdingKeys = accountId ? null : positions.map(positionSnapshotKey);
  const rangeProgress = investmentRangeProgress(store, { accountId, ticker: normalizedTicker, holdingKeys, range });
  // Detail rows can represent several accounts that hold the same security.
  // Calculate each row from its own verified snapshots for this exact range;
  // never reuse an overview metric that may have been fetched for another
  // timeframe.
  const holdingProgress = Object.fromEntries(positions.map((position) => [
    positionSnapshotKey(position),
    position.manual || !position.ticker
      ? null
      : investmentRangeProgress(store, {
        ticker: position.ticker,
        holdingKeys: [positionSnapshotKey(position)],
        range
      })
  ]));
  // Keep the account identity visible even if its provider has not supplied
  // positions in this response. A generic "$0 Investment account" is both
  // misleading and needlessly discards the nickname the person gave it.
  if (!positions.length && !accountId) return {
    state: 'unavailable',
    label: selectedAccount?.nickname || selectedAccount?.name || (accountId ? 'Investment account' : normalizedTicker),
    ticker: accountId ? null : normalizedTicker || null,
    value: selectedAccount ? Math.abs(Number(selectedAccount.current_balance || 0)) : 0,
    reason: 'This holding is not available from your latest connection.', history: [], market: [], progress: rangeProgress
  };
  const value = positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  const label = accountId
    ? (selectedAccount?.nickname || selectedAccount?.name || 'Investment account')
    : (positions[0].name || normalizedTicker);
  const providerHistory = providerPositionHistory(store, { accountId, ticker: normalizedTicker, holdingKeys });
  // An account drawer represents a person's tracked account balance. Its
  // history is therefore the daily account snapshots we captured from the
  // institution—not a trade/price reconstruction.
  if (accountId && selectedAccount) {
    const preparing = selectedAccount.item_id && (store.items || []).some((item) => item.id === selectedAccount.item_id && item.investment_history_state === 'preparing');
    const state = providerHistory.length >= 2 ? 'ready' : providerHistory.length === 1 ? 'tracking' : preparing ? 'preparing' : 'unavailable';
    return {
      state,
      label,
      ticker: null,
      value: Math.abs(Number(selectedAccount.current_balance || 0)),
      costBasis: null,
      gain: null,
      history: providerHistory,
      market: [],
      reconstructed: false,
      progress: rangeProgress,
      // Each account-drawer row gets the same selected-range, verified
      // snapshot calculation as the overview. Never derive it from trades or
      // quotes in the UI.
      holdingProgress,
      detail: providerHistory.length ? `Based on ${providerHistory.length} verified daily update${providerHistory.length === 1 ? '' : 's'} from your connected institution.` : undefined,
      reason: preparing ? 'Your institution is still preparing its reported investment activity.' : 'Daily account tracking will begin with your next verified update.'
    };
  }
  const itemIds = new Set((store.accounts || []).filter((account) => positions.some((position) => position.account_id === account.plaid_account_id)).map((account) => account.item_id));
  const preparing = (store.items || []).some((item) => itemIds.has(item.id) && item.investment_history_state === 'preparing');
  return {
    state: providerHistory.length >= 2 ? 'ready' : providerHistory.length === 1 ? 'tracking' : preparing ? 'preparing' : 'unavailable',
    label, ticker: normalizedTicker || null, value,
    costBasis: null, gain: null,
    history: providerHistory, market: [],
    progress: rangeProgress,
    holdingProgress,
    detail: providerHistory.length ? `Based on ${providerHistory.length} verified daily update${providerHistory.length === 1 ? '' : 's'} from your connected institution.` : undefined,
    reason: preparing ? 'Your institution is still preparing its reported investment activity.' : 'Daily holding tracking will begin with your next verified update.'
  };

}

function normalizedAccountText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function hideDuplicateAccounts(store) {
  const groups = new Map();
  for (const account of store.accounts) {
    const mask = String(account.mask || '').trim();
    // The final account digits are required for automatic hiding. This avoids
    // treating two real same-named accounts as duplicates when their identity
    // cannot be verified.
    if (!mask) continue;
    const key = [
      normalizedAccountText(account.institution_name),
      normalizedAccountText(account.official_name || account.name),
      normalizedAccountText(account.type),
      normalizedAccountText(account.subtype),
      mask
    ].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }

  let hidden = 0;
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    matches.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    const [winner, ...duplicates] = matches;
    winner.hidden = false;
    delete winner.hidden_reason;
    delete winner.duplicate_of;
    for (const duplicate of duplicates) {
      if (!duplicate.hidden || duplicate.hidden_reason !== 'duplicate') hidden += 1;
      duplicate.hidden = true;
      duplicate.hidden_reason = 'duplicate';
      duplicate.duplicate_of = winner.id;
    }
  }
  return hidden;
}

export function summarize(store, month = new Date().toISOString().slice(0, 7)) {
  return summarizeRange(store, month, '1m');
}

export function summarizeRange(store, month = new Date().toISOString().slice(0, 7), range = '1m') {
  const accounts = store.accounts.filter((a) => !a.hidden);
  const assets = accounts
    .filter((a) => accountSide(a.type) === 'asset')
    .reduce((sum, a) => sum + Number(a.current_balance || 0), 0);
  const liabilities = accounts
    .filter((a) => accountSide(a.type) === 'liability')
    .reduce((sum, a) => sum + Math.max(Number(a.current_balance || 0), 0), 0);

  const anchor = new Date(`${month}-01T12:00:00`);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  const start = new Date(anchor);
  if (range === '3m') start.setMonth(start.getMonth() - 2);
  else if (range === 'ytd') start.setMonth(0);
  else if (range === '1y') start.setMonth(start.getMonth() - 11);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const monthTx = store.transactions.filter((t) => t.date >= startDate && t.date <= endDate && !t.pending);
  const spend = { fixed: 0, savings: 0, investments: 0, guilt_free: 0 };
  let income = 0;

  for (const tx of monthTx) {
    if (tx.excluded || tx.bucket === 'transfer') continue;
    if (tx.bucket === 'income') {
      income += Math.abs(Number(tx.amount || 0));
      continue;
    }
    if (spend[tx.bucket] !== undefined && tx.amount > 0) spend[tx.bucket] += Number(tx.amount || 0);
  }

  const totalOut = Object.values(spend).reduce((a, b) => a + b, 0);
  const remaining = income - totalOut;
  return { assets, liabilities, netWorth: assets - liabilities, income, spend, totalOut, remaining, month, range, startDate, endDate };
}

export function cashRunway(store, anchorDate = new Date()) {
  const cash = store.accounts
    .filter((account) => !account.hidden && account.type === 'depository')
    .reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const anchor = new Date(anchorDate);
  const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth(), 0);
  const monthStart = new Date(monthEnd.getFullYear(), monthEnd.getMonth() - 2, 1).toISOString().slice(0, 10);
  const monthEndDate = monthEnd.toISOString().slice(0, 10);
  const monthly = new Map();
  for (const transaction of store.transactions) {
    if (transaction.pending || transaction.excluded || transaction.bucket !== 'fixed' || Number(transaction.amount || 0) <= 0) continue;
    if (transaction.date < monthStart || transaction.date > monthEndDate) continue;
    const month = transaction.date.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + Number(transaction.amount));
  }
  const monthTotals = [...monthly.values()];
  const essentialMonthly = monthTotals.length ? monthTotals.reduce((sum, value) => sum + value, 0) / monthTotals.length : null;
  return { cash, essentialMonthly, monthsObserved: monthTotals.length, runwayMonths: essentialMonthly ? cash / essentialMonthly : null };
}

export function goalProgress(store) {
  const accounts = (store.accounts || []).filter((account) => !account.hidden);
  const valueFor = (source) => {
    if (source === 'cash') return accounts.filter((account) => account.type === 'depository').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
    if (source === 'investments') return accounts.filter((account) => account.type === 'investment').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
    if (source === 'debt') return accounts.filter((account) => accountSide(account.type) === 'liability').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
    return summarizeRange(store).netWorth;
  };
  return (store.settings?.goals || []).map((goal) => {
    const target = Math.max(0, Number(goal.target || 0));
    const current = valueFor(goal.source);
    const debt = goal.source === 'debt';
    const progress = target ? Math.min(1, debt ? Math.max(0, 1 - current / target) : Math.max(0, current / target)) : 0;
    return { ...goal, target, current, progress, remaining: debt ? current : Math.max(0, target - current) };
  });
}

// A review should earn attention. It only names a category when the latest
// completed month is materially and unusually above a stable three-month norm.
export function monthlyReview(store, anchorDate = new Date()) {
  const anchor = new Date(anchorDate);
  const end = new Date(anchor.getFullYear(), anchor.getMonth(), 0);
  const latestMonth = end.toISOString().slice(0, 7);
  const priorMonths = [1, 2, 3].map((offset) => {
    const date = new Date(end.getFullYear(), end.getMonth() - offset, 1);
    return date.toISOString().slice(0, 7);
  });
  const byMonth = new Map([latestMonth, ...priorMonths].map((month) => [month, { spend: 0, saveInvest: 0, income: 0, categories: new Map() }]));
  for (const transaction of store.transactions || []) {
    if (transaction.pending || transaction.excluded || transaction.bucket === 'transfer') continue;
    const month = String(transaction.date || '').slice(0, 7);
    const row = byMonth.get(month);
    if (!row) continue;
    if (transaction.bucket === 'income') {
      row.income += Math.abs(Number(transaction.amount || 0));
      continue;
    }
    if (Number(transaction.amount || 0) <= 0) continue;
    if (transaction.bucket === 'savings' || transaction.bucket === 'investments') { row.saveInvest += Number(transaction.amount); continue; }
    if (!['fixed', 'guilt_free'].includes(transaction.bucket)) continue;
    row.spend += Number(transaction.amount);
    const category = String(transaction.pfc_primary || transaction.pfc_detailed || transaction.bucket).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
    row.categories.set(category, (row.categories.get(category) || 0) + Number(transaction.amount));
  }
  const latest = byMonth.get(latestMonth);
  const hasHistory = priorMonths.every((month) => byMonth.get(month)?.spend > 0);
  if (!latest || !hasHistory) return { available: false };
  let outlier = null;
  for (const [category, amount] of latest.categories) {
    const baseline = priorMonths.reduce((sum, month) => sum + Number(byMonth.get(month).categories.get(category) || 0), 0) / priorMonths.length;
    const difference = amount - baseline;
    if (amount >= 125 && baseline >= 50 && amount >= baseline * 1.65 && difference >= 125 && (!outlier || difference > outlier.difference)) outlier = { category, amount, baseline, difference };
  }
  return { available: true, month: latestMonth, income: latest.income, spend: latest.spend, saveInvest: latest.saveInvest, outlier };
}

// A deliberately small, evidence-based answer to “am I okay?” It never
// invents a reason for a change and only speaks when connected data supports
// a concrete next step or reassuring fact.
export function clarityCheckin(store, anchorDate = new Date()) {
  const connections = connectionHealth(store, anchorDate);
  const attention = connections.find((item) => item.state === 'attention' || item.state === 'stale');
  if (attention) {
    return {
      available: true, tone: attention.state === 'attention' ? 'attention' : 'watch', action: 'profile', actionLabel: 'View connections',
      title: attention.state === 'attention' ? `${attention.institution_name} needs attention` : `${attention.institution_name} is taking longer to update`,
      detail: 'Your existing data is still here. We will keep retrying automatically.'
    };
  }
  const review = monthlyReview(store, anchorDate);
  if (review.available && review.outlier) {
    return {
      available: true, tone: 'watch', action: 'spending', actionLabel: 'Review cash flow',
      title: `${review.outlier.category} was higher than usual`,
      detail: `${formatDollars(review.outlier.difference)} above your typical month in ${monthLabel(review.month)}. Everything else looks within your usual pattern.`
    };
  }
  // A person does not need another routine cash-flow verdict when things are
  // calm. Surface one clear freedom milestone instead, while reserving the
  // check-in for connection problems and genuinely material spending changes.
  const freedom = calculateFire(store, summarizeRange(store).netWorth);
  const nextStep = freedom.ladder?.find((step) => step.target > 0 && !step.complete);
  if (nextStep) {
    const progress = Math.min(99, Math.floor(Number(nextStep.progress || 0)));
    return {
      available: true, tone: 'steady', action: 'retirement', actionLabel: 'View your path',
      title: `Next: ${nextStep.name}`,
      detail: `${progress}% of ${formatDollars(nextStep.target)} · ${nextStep.detail}.`
    };
  }
  if (review.available && review.income > 0) {
    const remaining = review.income - review.spend - review.saveInvest;
    if (remaining >= 0) {
      return {
        available: true, tone: 'steady', action: 'spending', actionLabel: 'View cash flow',
        title: 'Last month stayed within take-home income',
        detail: `${formatDollars(remaining)} remained after actual spending, saving, and investing. Pre-tax retirement stays separate.`
      };
    }
    return {
      available: true, tone: 'watch', action: 'spending', actionLabel: 'Review cash flow',
      title: 'Last month used more than take-home income',
      detail: `${formatDollars(Math.abs(remaining))} more went out than came in. One-time purchases or annual investing can cause this, so it is worth a quick review.`
    };
  }
  const runway = cashRunway(store, anchorDate);
  if (runway.essentialMonthly && runway.runwayMonths >= 1) {
    return {
      available: true, tone: 'steady', action: 'accounts', actionLabel: 'View accounts',
      title: `Cash covers ${Math.min(99, runway.runwayMonths).toFixed(1)} months of essentials`,
      detail: `${formatDollars(runway.cash)} is available across cash accounts. We will add a monthly check-in as more transaction history arrives.`
    };
  }
  return { available: false };
}

function formatDollars(value) {
  return Number(value || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function monthLabel(month) {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString('en-US', { month: 'long' });
}

export function connectionHealth(store, now = new Date()) {
  // A daily connection can be temporarily delayed by an institution. Avoid
  // turning ordinary provider latency into an alarming user-facing alert.
  const staleCutoff = new Date(now).getTime() - 96 * 60 * 60 * 1000;
  return (store.items || []).filter((item) => !item.demo).map((item) => {
    // Connections created before automatic syncing did not have a
    // `last_synced_at` field. Their account records still have a trustworthy
    // provider-update timestamp, so use that as a one-way legacy fallback.
    // Do not let it conceal a recorded refresh failure or replace an explicit
    // sync timestamp once one exists.
    const accountUpdates = (store.accounts || [])
      .filter((account) => account.item_id === item.id)
      .map((account) => new Date(account.updated_at).getTime())
      .filter(Number.isFinite);
    const inferredAt = accountUpdates.length ? Math.max(...accountUpdates) : 0;
    const verifiedAt = item.last_verified_update_at ? new Date(item.last_verified_update_at).getTime() : 0;
    const explicitAt = item.last_synced_at ? new Date(item.last_synced_at).getTime() : 0;
    // `last_verified_update_at` is written only after /accounts/get succeeds.
    // Older stores do not have it, so a completed sync (then a provider
    // account timestamp) are honest compatibility fallbacks.
    const syncedAt = Number.isFinite(verifiedAt) && verifiedAt > 0 ? verifiedAt
      : Number.isFinite(explicitAt) && explicitAt > 0 ? explicitAt : inferredAt;
    const failureCount = Number(item.sync_failure_count || (item.last_sync_error_at ? 1 : 0));
    // Escalate only after three consecutive full-refresh failures. A single
    // failed daily attempt is retried automatically and should stay quiet.
    const state = item.requires_reconnect || failureCount >= 3 ? 'attention' : syncedAt < staleCutoff ? 'stale' : 'healthy';
    const updateSource = Number.isFinite(verifiedAt) && verifiedAt > 0 ? 'provider_accounts'
      : Number.isFinite(explicitAt) && explicitAt > 0 ? 'successful_sync'
        : inferredAt ? 'legacy_account_record' : 'unavailable';
    const lastVerified = syncedAt ? new Date(syncedAt).toISOString() : null;
    const lastAttempt = item.last_sync_attempt_at && Number.isFinite(new Date(item.last_sync_attempt_at).getTime())
      ? new Date(item.last_sync_attempt_at).toISOString() : null;
    const action = item.requires_reconnect ? 'reconnect' : state === 'stale' || state === 'attention' ? 'automatic_retry' : 'none';
    return {
      id: item.id,
      institution_name: item.institution_name,
      // Preserve the original field while exposing a clearer data-recency
      // contract for every UI surface. No provider error codes are exposed.
      last_synced_at: item.last_synced_at || lastVerified,
      last_verified_update_at: lastVerified,
      last_sync_attempt_at: lastAttempt,
      update_source: updateSource,
      has_verified_update: Boolean(lastVerified),
      failure_count: failureCount,
      requires_reconnect: Boolean(item.requires_reconnect),
      state,
      action,
      action_required: action === 'reconnect',
      retrying_automatically: action === 'automatic_retry'
    };
  });
}

function recurringMerchantKey(transaction) {
  return String(transaction.merchant_name || transaction.name || '').toLowerCase()
    .replace(/\b\d{3,}\b/g, '').replace(/[^a-z]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Plaid's recurring-streams product is not required for this lightweight
// signal. We only surface a conservative monthly-bill pattern the person's
// own posted activity supports, regardless of merchant category.
export function recurringCharges(store, anchor = new Date()) {
  const today = anchor.toISOString().slice(0, 10);
  const windowStart = new Date(anchor); windowStart.setDate(windowStart.getDate() - 190);
  const groups = new Map();
  for (const transaction of store.transactions || []) {
    if (transaction.pending || transaction.excluded || transaction.bucket === 'transfer' || Number(transaction.amount || 0) <= 0 || transaction.date < windowStart.toISOString().slice(0, 10)) continue;
    const key = recurringMerchantKey(transaction);
    if (key.length < 3) continue;
    const row = groups.get(key) || { key, name: transaction.merchant_name || transaction.name || 'Recurring charge', transactions: [] };
    row.transactions.push(transaction); groups.set(key, row);
  }
  const charges = [];
  for (const group of groups.values()) {
    const rowsByMonth = new Map();
    for (const row of group.transactions.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      const month = String(row.date).slice(0, 7);
      rowsByMonth.set(month, [...(rowsByMonth.get(month) || []), row]);
    }
    // A recurring bill normally posts once per month. Multiple charges in a
    // month are a useful signal that this merchant is ordinary activity.
    const rows = [...rowsByMonth.values()].filter((monthRows) => monthRows.length === 1).map(([row]) => row);
    if (rows.length < 3) continue;
    const intervals = rows.slice(1).map((row, index) => Math.round((new Date(`${row.date}T12:00:00`) - new Date(`${rows[index].date}T12:00:00`)) / 86400000));
    const interval = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)];
    const dayOfMonth = rows.map((row) => Number(String(row.date).slice(-2)));
    if (!(interval >= 24 && interval <= 38) || Math.max(...dayOfMonth) - Math.min(...dayOfMonth) > 5) continue;
    const latest = rows.at(-1), previous = rows.at(-2);
    const next = new Date(`${latest.date}T12:00:00`); next.setDate(next.getDate() + interval);
    const amount = Math.abs(Number(latest.amount || 0));
    const previousAmount = Math.abs(Number(previous.amount || 0));
    charges.push({ key: group.key, name: group.name, amount, interval, cadence: 'monthly', lastDate: latest.date, nextDate: next.toISOString().slice(0, 10), change: previousAmount ? (amount - previousAmount) / previousAmount : 0 });
  }
  const recurring = charges.sort((a, b) => b.amount - a.amount).slice(0, 4);
  return {
    recurring,
    upcoming: recurring.filter((charge) => charge.nextDate >= today).sort((a, b) => a.nextDate.localeCompare(b.nextDate)).slice(0, 3),
    increases: recurring.filter((charge) => charge.change >= .1 && charge.amount - (charge.amount / (1 + charge.change)) >= 5).sort((a, b) => b.change - a.change)
  };
}


function spendingPeriod(range, anchor = new Date(), transactions = []) {
  // Month-to-date is useful while a month is in progress. Comparisons over
  // several months are not: early-month bills frequently arrive before a
  // paycheck, producing a false-looking deficit. Those ranges therefore end
  // with the last fully completed calendar month.
  if (range === '1m') {
    return {
      startDate: new Date(anchor.getFullYear(), anchor.getMonth(), 1).toISOString().slice(0, 10),
      endDate: anchor.toISOString().slice(0, 10),
      completedMonths: false
    };
  }
  if (range === 'all') {
    const endDate = anchor.toISOString().slice(0, 10);
    const startDate = transactions
      .map((transaction) => String(transaction.date || ''))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= endDate)
      .sort()[0] || new Date(anchor.getFullYear(), anchor.getMonth(), 1).toISOString().slice(0, 10);
    return { startDate, endDate, completedMonths: false };
  }
  const end = new Date(anchor.getFullYear(), anchor.getMonth(), 0);
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  if (range === '3m') start.setMonth(start.getMonth() - 2);
  else if (range === '6m') start.setMonth(start.getMonth() - 5);
  else if (range === 'ytd') start.setMonth(0);
  else if (range === '1y') start.setMonth(start.getMonth() - 11);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    completedMonths: true
  };
}

function spendingCategory(transaction) {
  // The visual follows the Conscious Spending Plan's four intentional
  // allocations. Detailed merchant categories stay in Plaid data rather than
  // turning the main view into an unreadable bank-style category list.
  return {
    fixed: 'Fixed costs',
    savings: 'Savings',
    investments: 'Investments',
    guilt_free: 'Guilt-free spending'
  }[transaction.bucket] || 'Guilt-free spending';
}

// This is the single member-facing taxonomy for cash flow. Plaid's detailed
// categories remain useful provider evidence, but they are not a vocabulary a
// person should have to learn in order to correct a transaction.
export const CASH_FLOW_CATEGORY_OPTIONS = [
  { key: 'housing_bills', label: 'Housing & bills', bucket: 'fixed', flow: 'outflow' },
  { key: 'food_dining', label: 'Food & dining', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'transport', label: 'Transport', bucket: 'fixed', flow: 'outflow' },
  { key: 'health', label: 'Health', bucket: 'fixed', flow: 'outflow' },
  { key: 'insurance', label: 'Insurance', bucket: 'fixed', flow: 'outflow' },
  { key: 'home', label: 'Home', bucket: 'fixed', flow: 'outflow' },
  { key: 'shopping', label: 'Shopping', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'travel', label: 'Travel', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'entertainment', label: 'Entertainment', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'personal_care', label: 'Personal care', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'education', label: 'Education', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'services', label: 'Services', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'civic', label: 'Civic & giving', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'taxes', label: 'Taxes', bucket: 'fixed', flow: 'outflow' },
  { key: 'fees', label: 'Fees', bucket: 'fixed', flow: 'outflow' },
  { key: 'uncategorized', label: 'Uncategorized', bucket: 'guilt_free', flow: 'outflow' },
  { key: 'income_paychecks', label: 'Paychecks', bucket: 'income', flow: 'income' },
  { key: 'income_interest', label: 'Interest', bucket: 'income', flow: 'income' },
  { key: 'income_dividends', label: 'Dividends', bucket: 'income', flow: 'income' },
  { key: 'income_benefits', label: 'Benefits', bucket: 'income', flow: 'income' },
  { key: 'income_business', label: 'Business & freelance', bucket: 'income', flow: 'income' },
  { key: 'money_in_other', label: 'Other money in', bucket: 'income', flow: 'income' }
];

const cashFlowCategoryByKey = new Map(CASH_FLOW_CATEGORY_OPTIONS.map((category) => [category.key, category]));

export function cashFlowCategoryOption(key) {
  return cashFlowCategoryByKey.get(String(key || '')) || null;
}

function cashFlowDetail(transaction) {
  // Savings and investing are one post-tax allocation in the Sankey. Keep
  // the underlying bucket for summaries, but expose one canonical flow key so
  // the activity filter cannot drift into separate “Save” and “Invest” nodes.
  if (transaction.bucket === 'savings' || transaction.bucket === 'investments') {
    return { key: 'save_invest', label: 'Saved & invested', group: 'save_invest' };
  }
  const overridden = transaction.cash_flow_category_overridden && cashFlowCategoryOption(transaction.cash_flow_category);
  if (overridden) return { key: overridden.key, label: overridden.label, group: 'actual_spend' };
  const primary = String(transaction.pfc_primary || '').toUpperCase();
  const detailed = String(transaction.pfc_detailed || '').toUpperCase();
  const labels = {
    RENT_AND_UTILITIES: ['housing_bills', 'Housing & bills'],
    FOOD_AND_DRINK: ['food_dining', 'Food & dining'],
    GENERAL_MERCHANDISE: ['shopping', 'Shopping'],
    GENERAL_SERVICES: detailed.includes('INSURANCE') ? ['insurance', 'Insurance'] : detailed.includes('EDUCATION') ? ['education', 'Education'] : ['services', 'Services'],
    GOVERNMENT_AND_NON_PROFIT: detailed.includes('TAX') ? ['taxes', 'Taxes'] : ['civic', 'Civic & giving'],
    HOME_IMPROVEMENT: ['home', 'Home'],
    TRANSPORTATION: ['transport', 'Transport'],
    TRAVEL: ['travel', 'Travel'],
    ENTERTAINMENT: ['entertainment', 'Entertainment'],
    PERSONAL_CARE: ['personal_care', 'Personal care'],
    MEDICAL: ['health', 'Health'],
    BANK_FEES: ['fees', 'Fees']
  };
  const [key, label] = labels[primary] || ['uncategorized', 'Uncategorized'];
  return { key, label, group: 'actual_spend' };
}

// A merchant rule deliberately uses a narrow, human-recognizable key. It
// lets a correction to “Zelle Rent” repair prior rent payments, while never
// treating every payment made through Zelle, Venmo, or PayPal as the same
// merchant. The source name is preserved; this key is only for matching.
function categoryRuleKey(transaction) {
  let name = String(transaction.merchant_name || transaction.name || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\b(?:zelle|venmo|paypal|cash\s*app)\b[\s:*\-]*/g, '')
    .replace(/\b(?:transfer|payment|purchase|debit|credit)\b/g, '')
    .replace(/\b(?:ref|confirmation|conf|id)\s*[#:]*\s*[a-z0-9-]+\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (name.length < 3 || ['zelle', 'venmo', 'paypal', 'cash app', 'transfer', 'payment'].includes(name)) return '';
  return name;
}

function cashFlowCategoryRuleFlow(transaction) {
  const flow = cashFlowType(transaction);
  if (flow === 'external_outflow' && Number(transaction.amount || 0) > 0 && !['savings', 'investments', 'transfer'].includes(transaction.bucket)) return 'outflow';
  if (flow === 'external_inflow' && Number(transaction.amount || 0) < 0 && !['refund', 'investment_proceeds', 'loan_proceeds'].includes(inflowClassification(transaction))) return 'income';
  return null;
}

function applyCategory(transaction, category) {
  transaction.bucket = category.bucket;
  transaction.category_overridden = true;
  transaction.cash_flow_category = category.key;
  transaction.cash_flow_category_overridden = true;
}

function categoryRuleForTransaction(store, transaction) {
  const flow = cashFlowCategoryRuleFlow(transaction);
  const merchantKey = categoryRuleKey(transaction);
  if (!flow || !merchantKey) return null;
  const rule = (store.cash_flow_category_rules || []).find((candidate) => candidate.flow === flow && candidate.merchant_key === merchantKey);
  const category = rule && cashFlowCategoryOption(rule.category_key);
  return category?.flow === flow ? { rule, category } : null;
}

// A correction is remembered at the merchant-and-direction level. Run this
// after normalizing newly received Plaid records so future matching payments
// follow the person's own choice instead of reverting to provider labeling.
export function applyCashFlowCategoryRule(store, transaction) {
  const match = categoryRuleForTransaction(store, transaction);
  if (!match) return false;
  applyCategory(transaction, match.category);
  transaction.cash_flow_category_rule_id = match.rule.id;
  return true;
}

export function removeCashFlowCategoryRule(store, ruleId) {
  const rules = store.cash_flow_category_rules || [];
  const index = rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) return false;
  rules.splice(index, 1);
  return true;
}

export function applyCashFlowCategoryOverride(store, transactionId, categoryKey) {
  const selected = (store.transactions || []).find((transaction) => transaction.id === transactionId);
  const category = cashFlowCategoryOption(categoryKey);
  const selectedFlow = cashFlowCategoryRuleFlow(selected || {});
  const isOutflow = selectedFlow === 'outflow';
  const isIncome = selectedFlow === 'income';
  const ruleFlow = category?.flow === 'income' ? 'income' : category?.flow === 'outflow' ? 'outflow' : null;
  if (!selected || !category || selected.demo || selected.pending || (ruleFlow === 'outflow' ? !isOutflow : !isIncome)) return null;
  const ruleKey = categoryRuleKey(selected);
  if (!ruleKey) return null;
  store.cash_flow_category_rules ||= [];
  const ruleId = `${ruleFlow}:${ruleKey}`;
  const existingRule = store.cash_flow_category_rules.find((rule) => rule.id === ruleId);
  const rule = existingRule || { id: ruleId, merchant_key: ruleKey, flow: ruleFlow, category_key: category.key, created_at: new Date().toISOString() };
  rule.category_key = category.key;
  rule.updated_at = new Date().toISOString();
  if (!existingRule) store.cash_flow_category_rules.push(rule);
  let updated = 0;
  for (const transaction of store.transactions || []) {
    const transactionFlow = cashFlowCategoryRuleFlow(transaction);
    const matchingOutflow = ruleFlow === 'outflow' && transactionFlow === 'outflow';
    const matchingIncome = ruleFlow === 'income' && transactionFlow === 'income';
    if (transaction.demo || transaction.pending || (!matchingOutflow && !matchingIncome)) continue;
    const isSelected = transaction.id === selected.id;
    const isMerchantMatch = Boolean(ruleKey) && categoryRuleKey(transaction) === ruleKey;
    if (!isSelected && !isMerchantMatch) continue;
    // This is a merchant-level rule, not a one-off row edit. It applies to
    // every safely matched record in either direction of history, so choosing
    // a category on an old transaction does not leave newer duplicates behind.
    applyCategory(transaction, category);
    transaction.cash_flow_category_rule_id = rule.id;
    updated += 1;
  }
  return { updated, category, rule, matchedDuplicates: Math.max(0, updated - 1) };
}

function transactionKey(transaction, index) {
  return transaction.id || transaction.plaid_transaction_id || `${transaction.date}:${index}`;
}

// This is the one economic interpretation used by both Cash Flow and
// Retirement. Feature-specific code may choose a date window or an
// aggregation statistic, but it must not reinterpret a row here.
export function canonicalEconomicLedger(store) {
  const accounts = new Map((store.accounts || []).map((account) => [String(account.plaid_account_id || account.id), account]));
  const posted = (store.transactions || [])
    .map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction }) => !transaction.pending && !transaction.excluded && /^\d{4}-\d{2}-\d{2}$/.test(String(transaction.date || '')))
    .sort((left, right) => String(left.transaction.date).localeCompare(String(right.transaction.date)) || left.index - right.index);
  const expenses = posted.filter(({ transaction }) => cashFlowType(transaction) === 'external_outflow' && Number(transaction.amount || 0) > 0 && !['savings', 'investments'].includes(transaction.bucket));
  const remaining = new Map(expenses.map(({ transaction, index }) => [transactionKey(transaction, index), Number(transaction.amount || 0)]));
  const normalizedMerchant = (transaction) => String(transaction.merchant_name || transaction.name || '').toLowerCase().replace(/\b(refund|return|reversal|credit)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const allocations = new Map();
  const refundRows = posted.filter(({ transaction }) => cashFlowType(transaction) === 'external_inflow' && inflowClassification(transaction) === 'refund');
  for (const { transaction: refund, index } of refundRows) {
    let left = Math.abs(Number(refund.amount || 0));
    if (!(left > 0)) continue;
    const refundFlow = cashFlowDetail({ ...refund, bucket: 'guilt_free' });
    const merchant = normalizedMerchant(refund);
    const candidates = expenses
      .filter(({ transaction: expense, index }) => expense.date <= refund.date && (remaining.get(transactionKey(expense, index)) || 0) > 0)
      .sort((a, b) => String(b.transaction.date).localeCompare(String(a.transaction.date)));
    const merchantCandidates = merchant ? candidates.filter(({ transaction: expense }) => normalizedMerchant(expense) === merchant) : [];
    const categoryCandidates = candidates.filter(({ transaction: expense }) => cashFlowDetail(expense).key === refundFlow.key);
    for (const candidate of [...merchantCandidates, ...categoryCandidates.filter((row) => !merchantCandidates.includes(row)), ...candidates.filter((row) => !merchantCandidates.includes(row) && !categoryCandidates.includes(row))]) {
      if (!(left > 0)) break;
      const expense = candidate.transaction;
      const expenseId = transactionKey(expense, candidate.index);
      const available = remaining.get(expenseId) || 0;
      if (!(available > 0)) continue;
      const amount = Math.min(left, available);
      remaining.set(expenseId, available - amount);
      allocations.set(transactionKey(refund, index), (allocations.get(transactionKey(refund, index)) || 0) + amount);
      left -= amount;
    }
  }
  return posted.map(({ transaction, index }) => {
    const flowType = cashFlowType(transaction);
    const account = accounts.get(String(transaction.account_id || ''));
    const sourceIsInvestment = transaction.source === 'investment_transaction' || account?.type === 'investment';
    let economicType = 'ambiguous';
    if (flowType === 'external_inflow') {
      const incoming = inflowClassification(transaction);
      economicType = incoming === 'income' && isConfirmedIncome(transaction) ? 'income' : incoming;
      if (incoming === 'refund' && allocations.has(transactionKey(transaction, index))) economicType = 'refund';
    } else if (flowType === 'pre_tax_retirement') economicType = 'payroll_retirement_contribution';
    else if (flowType === 'internal_transfer') {
      const detailed = String(transaction.pfc_detailed || transaction.personal_finance_category?.detailed || '').toUpperCase();
      if (detailed.includes('CREDIT_CARD_PAYMENT') || /PAYMENT THANK YOU|AUTOPAY PAYMENT/.test(String(transaction.name || '').toUpperCase())) economicType = 'credit_card_payment';
      else if (transaction.bucket === 'savings') economicType = 'savings_transfer';
      else if (transaction.bucket === 'investments' && !sourceIsInvestment) economicType = 'investment_funding';
      else economicType = 'internal_transfer';
    } else if (flowType === 'external_outflow') {
      if (transaction.bucket === 'savings') economicType = 'savings_transfer';
      else if (transaction.bucket === 'investments') economicType = sourceIsInvestment ? 'investment_activity' : 'investment_funding';
      else economicType = 'expense';
    }
    const refundAmount = allocations.get(transactionKey(transaction, index)) || 0;
    const flow = cashFlowDetail(transaction);
    const essential = economicType === 'expense' && transaction.bucket === 'fixed';
    return { ...transaction, transaction_id: transactionKey(transaction, index), economicType, amount: Number(transaction.amount || 0), value: economicType === 'refund' ? -refundAmount : Math.abs(Number(transaction.amount || 0)), refundAmount, flowKey: flow.key, flowLabel: flow.label, essential };
  });
}

export function monthlyFinancialFacts(store, options = {}) {
  const rows = canonicalEconomicLedger(store).filter((row) => (!options.startDate || row.date >= options.startDate) && (!options.endDate || row.date <= options.endDate));
  const facts = new Map();
  const ensure = (month) => {
    if (!facts.has(month)) facts.set(month, { month, income: 0, actualSpend: 0, essentialSpend: 0, discretionarySpend: 0, refunds: 0, cashSavings: 0, investmentContributions: 0, postTaxInvestmentContributions: 0, payrollRetirementContributions: 0 });
    return facts.get(month);
  };
  for (const row of rows) {
    const fact = ensure(String(row.date).slice(0, 7));
    if (row.economicType === 'income') fact.income += row.value;
    else if (row.economicType === 'expense' || row.economicType === 'refund') {
      fact.actualSpend += row.value;
      if (row.economicType === 'refund') fact.refunds += Math.abs(row.value);
      if (row.essential) fact.essentialSpend += row.value;
      else fact.discretionarySpend += row.value;
    } else if (row.economicType === 'savings_transfer') fact.cashSavings += row.value;
    else if (row.economicType === 'investment_funding') { fact.investmentContributions += row.value; fact.postTaxInvestmentContributions += row.value; }
    else if (row.economicType === 'payroll_retirement_contribution') { fact.investmentContributions += row.value; fact.payrollRetirementContributions += row.value; }
  }
  return [...facts.values()].sort((a, b) => a.month.localeCompare(b.month));
}

// Plaid's income category is intentionally broad. Keep the main cash-flow
// calculation broad too, but retain the source so a paycheck is not made to
// look indistinguishable from HYSA interest, benefits, or self-employment.
function incomeSource(transaction) {
  const overridden = transaction.cash_flow_category_overridden && cashFlowCategoryOption(transaction.cash_flow_category);
  if (overridden?.flow === 'income') return overridden;
  const primary = String(transaction.pfc_primary || '').toUpperCase();
  const detailed = String(transaction.pfc_detailed || '').toUpperCase();
  const name = `${transaction.merchant_name || ''} ${transaction.name || ''}`.toUpperCase();
  const context = `${primary} ${detailed} ${name}`;
  if (/INTEREST/.test(context)) return cashFlowCategoryOption('income_interest');
  if (/DIVIDEND/.test(context)) return cashFlowCategoryOption('income_dividends');
  if (/PAYROLL|SALARY|WAGE/.test(context)) return cashFlowCategoryOption('income_paychecks');
  if (/BENEFIT|UNEMPLOYMENT|SOCIAL_SECURITY|PENSION/.test(context)) return cashFlowCategoryOption('income_benefits');
  if (/FREELANCE|CONTRACT|BUSINESS|GIG/.test(context)) return cashFlowCategoryOption('income_business');
  // An incoming refund, reimbursement, severance payment, or one-off credit
  // is still real money in, but we must not claim to know that it was earned
  // income when the provider did not tell us so.
  return cashFlowCategoryOption('money_in_other');
}

export function spendingSummary(store, range = '1m', anchor = new Date()) {
  const { startDate, endDate, completedMonths } = spendingPeriod(range, anchor, store.transactions || []);
  const categories = new Map();
  const merchants = new Map();
  const monthly = new Map();
  const monthlyIncome = new Map();
  const monthlyPreTaxRetirement = new Map();
  const monthlyActualSpend = new Map();
  const monthlySavedInvested = new Map();
  const incomeSourceMap = new Map();
  const transactionRows = [];
  const actualSpendCategoryMap = new Map();
  let actualSpend = 0;
  let savings = 0;
  let investments = 0;
  let savingsAndInvestments = 0;
  const incomeTransactions = store.transactions.filter((transaction) => {
    // Cash flow follows the posted signed ledger, not a spending category.
    // Categories can change; whether external money entered the connected
    // accounts cannot. Provider-confirmed transfers remain outside cash flow.
    if (transaction.pending || transaction.excluded || cashFlowType(transaction) !== 'external_inflow' || !isConfirmedIncome(transaction)) return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
  for (const transaction of incomeTransactions) {
    const month = String(transaction.date).slice(0, 7);
    const amount = Math.abs(Number(transaction.amount || 0));
    const source = incomeSource(transaction);
    monthlyIncome.set(month, (monthlyIncome.get(month) || 0) + amount);
    incomeSourceMap.set(source.key, { key: source.key, label: source.label, amount: (incomeSourceMap.get(source.key)?.amount || 0) + amount });
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: transaction.merchant_name || transaction.name || 'Income',
      date: transaction.date,
      amount,
      category: source.label,
      bucket: 'income',
      cashFlowCategory: source.key,
      categoryRuleId: categoryRuleForTransaction(store, transaction)?.rule.id || null,
      flowKey: source.key,
      flowLabel: source.label,
      flowGroup: 'income'
    });
  }
  // Payroll retirement deferrals are pre-tax: they never arrive in a checking
  // account, so including them in money out would compare gross savings with
  // net take-home income. Keep them visible, but outside cash flow.
  const preTaxRetirementTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || cashFlowType(transaction) !== 'pre_tax_retirement') return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
  for (const transaction of preTaxRetirementTransactions) {
    const month = String(transaction.date).slice(0, 7);
    const amount = Math.abs(Number(transaction.amount || 0));
    monthlyPreTaxRetirement.set(month, (monthlyPreTaxRetirement.get(month) || 0) + amount);
    // These are intentionally available in the activity drawer even though
    // they stay outside take-home cash flow. A person should be able to see
    // exactly which payroll deductions make up this companion total.
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: transaction.merchant_name || transaction.name || 'Payroll contribution',
      date: transaction.date,
      amount,
      category: 'Payroll retirement',
      bucket: 'pre_tax_retirement',
      flowKey: 'payroll_retirement',
      flowLabel: 'Payroll retirement',
      flowGroup: 'payroll_retirement'
    });
  }
  const eligibleTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || cashFlowType(transaction) !== 'external_outflow') return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
  const postedTransactions = store.transactions.filter((transaction) => !transaction.pending && !transaction.excluded && transaction.date >= startDate && transaction.date <= endDate);
  const positiveExpenses = postedTransactions.filter((transaction) => cashFlowType(transaction) === 'external_outflow' && Number(transaction.amount || 0) > 0 && !['savings', 'investments'].includes(transaction.bucket));
  const expenseRemaining = new Map(positiveExpenses.map((expense, index) => [expense.id || expense.plaid_transaction_id || `${expense.date}:${index}`, Number(expense.amount || 0)]));
  const normalizedMerchant = (transaction) => String(transaction.merchant_name || transaction.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const refundRows = postedTransactions.filter((transaction) => cashFlowType(transaction) === 'external_inflow' && inflowClassification(transaction) === 'refund');
  const attributableRefunds = new Map();
  for (const refund of refundRows) {
    const refundFlow = cashFlowDetail({ ...refund, bucket: 'guilt_free' });
    const merchant = normalizedMerchant(refund);
    const match = positiveExpenses.find((expense, index) => {
      if (expense.date > refund.date) return false;
      const expenseId = expense.id || expense.plaid_transaction_id || `${expense.date}:${index}`;
      if ((expenseRemaining.get(expenseId) || 0) <= 0) return false;
      const expenseFlow = cashFlowDetail(expense);
      if (expenseFlow.key !== refundFlow.key) return false;
      return merchant && normalizedMerchant(expense) === merchant;
    }) || positiveExpenses.find((expense, index) => {
      if (expense.date > refund.date || cashFlowDetail(expense).key !== refundFlow.key) return false;
      const expenseId = expense.id || expense.plaid_transaction_id || `${expense.date}:${index}`;
      return (expenseRemaining.get(expenseId) || 0) > 0;
    });
    if (match) {
      const matchIndex = positiveExpenses.indexOf(match);
      const expenseId = match.id || match.plaid_transaction_id || `${match.date}:${matchIndex}`;
      const amount = Math.min(Math.abs(Number(refund.amount || 0)), expenseRemaining.get(expenseId) || 0);
      if (amount > 0) {
        expenseRemaining.set(expenseId, (expenseRemaining.get(expenseId) || 0) - amount);
        attributableRefunds.set(refund.id || refund.plaid_transaction_id || `${refund.date}:${merchant}`, { refund, flow: refundFlow, amount });
      }
    }
  }
  for (const transaction of eligibleTransactions) {
    const amount = Number(transaction.amount);
    if (transaction.bucket === 'savings') { savings += amount; savingsAndInvestments += amount; }
    else if (transaction.bucket === 'investments') { investments += amount; savingsAndInvestments += amount; }
    else actualSpend += amount;
    const flow = cashFlowDetail(transaction);
    if (flow.group === 'actual_spend') actualSpendCategoryMap.set(flow.key, { name: flow.label, key: flow.key, amount: (actualSpendCategoryMap.get(flow.key)?.amount || 0) + amount });
    const category = spendingCategory(transaction);
    categories.set(category, (categories.get(category) || 0) + amount);
    const merchant = transaction.merchant_name || transaction.name || 'Unrecognized merchant';
    merchants.set(merchant, (merchants.get(merchant) || 0) + amount);
    const month = String(transaction.date).slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + amount);
    if (transaction.bucket === 'savings' || transaction.bucket === 'investments') monthlySavedInvested.set(month, (monthlySavedInvested.get(month) || 0) + amount);
    else monthlyActualSpend.set(month, (monthlyActualSpend.get(month) || 0) + amount);
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: merchant,
      date: transaction.date,
      amount,
      category,
      bucket: transaction.bucket,
      cashFlowCategory: flow.key,
      categoryRuleId: categoryRuleForTransaction(store, transaction)?.rule.id || null,
      flowKey: flow.key,
      flowLabel: flow.label,
      flowGroup: flow.group
    });
  }
  for (const { refund, flow, amount: refundAmount } of attributableRefunds.values()) {
    const amount = -Math.abs(Number(refundAmount || 0));
    const month = String(refund.date).slice(0, 7);
    actualSpend += amount;
    actualSpendCategoryMap.set(flow.key, { name: flow.label, key: flow.key, amount: (actualSpendCategoryMap.get(flow.key)?.amount || 0) + amount });
    categories.set(flow.label, (categories.get(flow.label) || 0) + amount);
    merchants.set(refund.merchant_name || refund.name || 'Unrecognized merchant', (merchants.get(refund.merchant_name || refund.name || 'Unrecognized merchant') || 0) + amount);
    monthly.set(month, (monthly.get(month) || 0) + amount);
    monthlyActualSpend.set(month, (monthlyActualSpend.get(month) || 0) + amount);
    transactionRows.push({
      id: refund.id || refund.plaid_transaction_id,
      name: refund.merchant_name || refund.name || 'Refund',
      date: refund.date,
      amount,
      category: flow.label,
      bucket: 'refund',
      flowKey: flow.key,
      flowLabel: flow.label,
      flowGroup: 'actual_spend'
    });
  }
  // Provider-confirmed transfers do not belong in take-home spending, but
  // they are still real saving/investing activity. Surface them in the
  // activity drawer and Sankey branch without adding them to actual spend.
  const transactionRowIds = new Set(transactionRows.map((row) => row.id).filter(Boolean));
  const accountById = new Map((store.accounts || []).map((account) => [String(account.plaid_account_id || account.id), account]));
  const contributionTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || transaction.date < startDate || transaction.date > endDate) return false;
    return (Number(transaction.amount || 0) > 0 && ['savings', 'investments'].includes(transaction.bucket))
      || Number(transaction.investment_contribution_amount || 0) > 0;
  });
  let savedInvested = 0;
  for (const transaction of contributionTransactions) {
    // The Sankey is a take-home cash-flow view. Payroll deferrals and moves
    // within an already-invested account belong in the investment ledger, not
    // in post-tax money-in / money-out reconciliation.
    const sourceAccount = accountById.get(String(transaction.account_id || ''));
    const sourceIsInvestment = transaction.source === 'investment_transaction'
      || sourceAccount?.type === 'investment'
      || (String(sourceAccount?.subtype || '').toLowerCase() === 'hsa' && !transaction.investment_contribution_account_id);
    if (sourceIsInvestment) continue;
    const amount = Number(transaction.investment_contribution_amount || transaction.amount || 0);
    if (!(amount > 0)) continue;
    savedInvested += amount;
    const id = transaction.id || transaction.plaid_transaction_id;
    if (id && transactionRowIds.has(id)) continue;
    if (id) transactionRowIds.add(id);
    transactionRows.push({
      id,
      name: transaction.merchant_name || transaction.name || 'Saved or invested',
      date: transaction.date,
      amount,
      category: 'Saved & invested',
      bucket: transaction.source === 'investment_transaction' ? 'pre_tax_retirement' : transaction.bucket || 'investments',
      flowKey: 'save_invest',
      flowLabel: 'Saved & invested',
      flowGroup: 'save_invest'
    });
  }
  // All feature-facing totals are derived from the canonical ledger. The
  // older loops above still build activity rows and display categories, but
  // they must not become a second economic interpretation of a transaction.
  const canonicalRows = canonicalEconomicLedger(store).filter((row) => row.date >= startDate && row.date <= endDate);
  const canonicalFacts = monthlyFinancialFacts(store, { startDate, endDate });
  actualSpend = 0;
  savings = 0;
  investments = 0;
  savingsAndInvestments = 0;
  monthlyIncome.clear();
  monthlyPreTaxRetirement.clear();
  monthlyActualSpend.clear();
  monthlySavedInvested.clear();
  actualSpendCategoryMap.clear();
  incomeSourceMap.clear();
  for (const row of canonicalRows) {
    const month = String(row.date).slice(0, 7);
    if (row.economicType === 'income') {
      monthlyIncome.set(month, (monthlyIncome.get(month) || 0) + row.value);
      const source = incomeSource(row);
      incomeSourceMap.set(source.key, { key: source.key, label: source.label, amount: (incomeSourceMap.get(source.key)?.amount || 0) + row.value });
    } else if (row.economicType === 'expense' || row.economicType === 'refund') {
      actualSpend += row.value;
      const flow = cashFlowDetail(row);
      actualSpendCategoryMap.set(flow.key, { name: flow.label, key: flow.key, amount: (actualSpendCategoryMap.get(flow.key)?.amount || 0) + row.value });
      monthlyActualSpend.set(month, (monthlyActualSpend.get(month) || 0) + row.value);
    } else if (row.economicType === 'savings_transfer') {
      savings += row.value;
      savingsAndInvestments += row.value;
      monthlySavedInvested.set(month, (monthlySavedInvested.get(month) || 0) + row.value);
    } else if (row.economicType === 'investment_funding') {
      investments += row.value;
      savingsAndInvestments += row.value;
      monthlySavedInvested.set(month, (monthlySavedInvested.get(month) || 0) + row.value);
    } else if (row.economicType === 'payroll_retirement_contribution') {
      monthlyPreTaxRetirement.set(month, (monthlyPreTaxRetirement.get(month) || 0) + row.value);
    }
  }
  const total = [...categories.values()].reduce((sum, amount) => sum + amount, 0);
  const categoryRows = [...actualSpendCategoryMap.values()]
    .filter(({ amount }) => amount > 0)
    .map(({ name, amount }) => ({ name, amount, share: actualSpend ? amount / actualSpend : 0 }))
    .sort((a, b) => b.amount - a.amount);
  // Allocate the leftover percentage points by largest remainder so the UI
  // always reconciles to 100%, rather than showing independently rounded values.
  const wholePercent = categoryRows.map((row) => Math.floor(row.share * 100));
  let remainingPercent = 100 - wholePercent.reduce((sum, value) => sum + value, 0);
  [...categoryRows.keys()].sort((a, b) => (categoryRows[b].share * 100 % 1) - (categoryRows[a].share * 100 % 1)).forEach((index) => {
    if (remainingPercent > 0) { wholePercent[index] += 1; remainingPercent -= 1; }
  });
  categoryRows.forEach((row, index) => { row.percentage = actualSpend ? wholePercent[index] : 0; });
  const topMerchants = [...merchants.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const monthCount = Math.max(1, (new Date(`${endDate}T12:00:00`).getFullYear() - new Date(`${startDate}T12:00:00`).getFullYear()) * 12 + new Date(`${endDate}T12:00:00`).getMonth() - new Date(`${startDate}T12:00:00`).getMonth() + 1);
  const monthlyRows = [...new Set([...monthly.keys(), ...monthlyIncome.keys(), ...monthlyPreTaxRetirement.keys()])]
    .map((month) => ({ month, amount: monthlyActualSpend.get(month) || 0, actual_spend: monthlyActualSpend.get(month) || 0, saved_invested: monthlySavedInvested.get(month) || 0, income: monthlyIncome.get(month) || 0, pre_tax_retirement: monthlyPreTaxRetirement.get(month) || 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const income = canonicalFacts.reduce((sum, fact) => sum + fact.income, 0);
  const incomeSources = [...incomeSourceMap.values()].sort((a, b) => b.amount - a.amount);
  const preTaxRetirement = [...monthlyPreTaxRetirement.values()].reduce((sum, amount) => sum + amount, 0);
  const actualSpendCategories = [...actualSpendCategoryMap.values()].filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount);
  const categoryRules = (store.cash_flow_category_rules || []).flatMap((rule) => {
    const category = cashFlowCategoryOption(rule.category_key);
    return category?.flow === rule.flow ? [{ id: rule.id, categoryKey: category.key, categoryLabel: category.label, flow: rule.flow }] : [];
  });
  return { range, startDate, endDate, completedMonths, total, income, incomeSources, actualSpend, netCashFlow: income - actualSpend, actualSpendCategories, savings, investments, savingsAndInvestments, savedInvested, preTaxRetirement, monthlyAverage: total / monthCount, categories: categoryRows, categoryOptions: CASH_FLOW_CATEGORY_OPTIONS, categoryRules, topMerchants, monthly: monthlyRows, transactions: transactionRows };
}

function monthId(dateString) {
  return String(dateString || '').slice(0, 7);
}

function trailingPostedTransactionWindow(store, requestedMonths = 12) {
  const maxMonths = Math.max(3, Math.min(24, Math.round(Number(requestedMonths) || 12)));
  const posted = (store.transactions || [])
    .filter((transaction) => !transaction.pending && !transaction.excluded && /^\d{4}-\d{2}-\d{2}$/.test(String(transaction.date || '')))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  // A partial current month has not had a full chance to receive paychecks,
  // bills, or contributions. Retirement inputs use only completed months.
  if (!posted.length) return { transactions: [], months: [] };
  const currentMonth = new Date().toISOString().slice(0, 7);
  const mostRecentPostedMonth = monthId(posted.at(-1).date);
  const completed = mostRecentPostedMonth === currentMonth
    ? posted.filter((transaction) => monthId(transaction.date) < currentMonth)
    : posted;
  if (!completed.length) return { transactions: [], months: [] };

  const latest = new Date(`${monthId(completed.at(-1).date)}-01T12:00:00`);
  const earliest = new Date(`${monthId(completed[0].date)}-01T12:00:00`);
  const spanMonths = (latest.getFullYear() - earliest.getFullYear()) * 12 + latest.getMonth() - earliest.getMonth() + 1;
  const start = new Date(latest);
  start.setMonth(start.getMonth() - Math.min(maxMonths - 1, spanMonths - 1));
  const startMonth = start.toISOString().slice(0, 7);
  const windowEndMonth = latest.toISOString().slice(0, 7);
  const transactions = completed.filter((transaction) => {
    const month = monthId(transaction.date);
    return month >= startMonth && month <= windowEndMonth;
  });
  const months = [];
  const cursor = new Date(`${startMonth}-01T12:00:00`);
  while (cursor <= latest) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return { transactions, months };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function contributionHistoryWindow(store, maxMonths = 24) {
  const posted = canonicalEconomicLedger(store)
    .filter((row) => ['investment_funding', 'payroll_retirement_contribution'].includes(row.economicType))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!posted.length) return { rows: [], months: [], monthsObserved: 0 };
  const currentMonth = new Date().toISOString().slice(0, 7);
  const complete = posted.filter((row) => String(row.date).slice(0, 7) < currentMonth);
  if (!complete.length) return { rows: [], months: [], monthsObserved: 0 };
  const latestMonth = String(complete.at(-1).date).slice(0, 7);
  const latest = new Date(`${latestMonth}-01T12:00:00`);
  const earliestAllowed = new Date(latest);
  earliestAllowed.setMonth(earliestAllowed.getMonth() - (maxMonths - 1));
  const firstObservedMonth = String(complete[0].date).slice(0, 7);
  const startMonth = firstObservedMonth > earliestAllowed.toISOString().slice(0, 7)
    ? firstObservedMonth
    : earliestAllowed.toISOString().slice(0, 7);
  const rows = complete.filter((row) => {
    const month = String(row.date).slice(0, 7);
    return month >= startMonth && month <= latestMonth;
  });
  const months = [];
  const cursor = new Date(`${startMonth}-01T12:00:00`);
  while (cursor <= latest) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return { rows, months, monthsObserved: months.length };
}

function contributionStreamKey(row) {
  const accountId = row.investment_contribution_account_id || row.account_id || 'unknown';
  if (row.economicType === 'payroll_retirement_contribution') return `payroll:${accountId}`;
  return `investment:${accountId}`;
}

function contributionStreamName(row) {
  if (row.economicType === 'payroll_retirement_contribution') {
    const text = `${row.merchant_name || ''} ${row.name || ''}`.toUpperCase();
    if (/HSA/.test(text)) return 'HSA payroll contributions';
    if (/401\s*\(?K\)?/.test(text)) return '401(k) contributions';
    if (/403\s*\(?B\)?/.test(text)) return '403(b) contributions';
    return 'Payroll retirement contributions';
  }
  const account = row.investment_contribution_account_id || row.account_id;
  return account ? `Investment account ${account}` : 'Investment funding';
}

function contributionCadence(intervals) {
  if (intervals.length < 1) return null;
  const typical = median(intervals);
  const tolerance = (value, low, high) => value >= low && value <= high;
  if (tolerance(typical, 5, 9)) return { key: 'weekly', days: 7, occurrencesPerYear: 52 };
  if (tolerance(typical, 12, 17)) return { key: 'biweekly', days: 14, occurrencesPerYear: 26 };
  if (tolerance(typical, 20, 45)) return { key: 'monthly', days: 30.4375, occurrencesPerYear: 12 };
  if (tolerance(typical, 75, 110)) return { key: 'quarterly', days: 91.3125, occurrencesPerYear: 4 };
  if (tolerance(typical, 330, 400)) return { key: 'annual', days: 365.25, occurrencesPerYear: 1 };
  return null;
}

function oneTimeIncomeNear(store, date) {
  const target = Date.parse(`${date}T12:00:00`);
  return (store.transactions || []).some((transaction) => {
    if (transaction.pending || transaction.excluded || Number(transaction.amount || 0) >= 0) return false;
    const transactionDate = Date.parse(`${transaction.date}T12:00:00`);
    if (!Number.isFinite(transactionDate) || Math.abs(transactionDate - target) > 45 * 86400000) return false;
    const context = `${transaction.merchant_name || ''} ${transaction.name || ''} ${transaction.pfc_primary || ''} ${transaction.pfc_detailed || ''}`.toUpperCase();
    return /SEVERANCE|PTO|VACATION PAY|TERMINATION|SETTLEMENT|INHERITANCE|WINDFALL/.test(context);
  });
}

function classifyContributionStream(store, events) {
  const ordered = [...events].sort((a, b) => a.date.localeCompare(b.date));
  const intervals = ordered.slice(1).map((event, index) => Math.round((Date.parse(`${event.date}T12:00:00`) - Date.parse(`${ordered[index].date}T12:00:00`)) / 86400000));
  const cadence = contributionCadence(intervals);
  const amounts = ordered.map((event) => event.amount);
  const typicalAmount = median(amounts);
  const repeated = ordered.length >= 3;
  const annualPattern = ordered.length >= 2 && cadence?.key === 'annual';
  const cadenceReliable = cadence && (repeated || annualPattern);
  const incomeBackedOutlier = typicalAmount > 0 && ordered.length >= 2
    ? ordered.find((event) => event.amount > typicalAmount * 1.5 && oneTimeIncomeNear(store, event.date))
    : null;
  const outlier = typicalAmount > 0 && ordered.length >= 4
    ? ordered.find((event) => event.amount > typicalAmount * 2.5)
    : null;
  const hasReturnToBaseline = outlier
    && ordered.filter((event) => event.date > outlier.date && event.amount <= typicalAmount * 1.5).length >= 2;
  const oneTime = ordered.length === 1
    || Boolean(incomeBackedOutlier && !cadenceReliable)
    || Boolean(outlier && hasReturnToBaseline && !cadenceReliable);
  let behavior = 'uncertain';
  let confidence = 'low';
  if (cadenceReliable && !oneTime) {
    behavior = cadence.key === 'annual' || cadence.key === 'quarterly' ? 'recurring_lumpy' : 'recurring';
    confidence = ordered.length >= 6 ? 'high' : 'medium';
  } else if (oneTime) {
    behavior = 'one_time';
    confidence = incomeBackedOutlier || hasReturnToBaseline ? 'high' : 'medium';
  }
  const eligibleEvents = behavior === 'recurring' || behavior === 'recurring_lumpy'
    ? ordered.filter((event) => event !== incomeBackedOutlier && !(outlier && event.date === outlier.date && hasReturnToBaseline))
    : [];
  const normalizedAmount = eligibleEvents.length ? median(eligibleEvents.map((event) => event.amount)) : 0;
  const annualAmount = cadence && eligibleEvents.length ? normalizedAmount * cadence.occurrencesPerYear : 0;
  return {
    key: contributionStreamKey(ordered[0].row),
    name: contributionStreamName(ordered[0].row),
    behavior,
    confidence,
    cadence: cadence?.key || null,
    eventCount: ordered.length,
    annualAmount,
    monthlyAmount: annualAmount / 12,
    events: ordered.map((event) => ({ date: event.date, amount: event.amount, transactionId: event.transactionId }))
  };
}

export function estimateOngoingContributions(store) {
  const history = contributionHistoryWindow(store);
  const grouped = new Map();
  for (const row of history.rows) {
    const transactionId = row.transaction_id;
    if (!transactionId || !(row.value > 0)) continue;
    const key = contributionStreamKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ row, date: row.date, amount: row.value, transactionId });
  }
  const streams = [...grouped.values()].map((events) => classifyContributionStream(store, events));
  const ongoingStreams = streams.filter((stream) => ['recurring', 'recurring_lumpy'].includes(stream.behavior));
  const annualAmount = ongoingStreams.reduce((sum, stream) => sum + stream.annualAmount, 0);
  const incompleteCoverage = (store.items || []).some((item) => item.investment_ledger?.complete === false || item.transactions_history_complete === false);
  const quality = !streams.length || history.monthsObserved < 3 || incompleteCoverage
    ? 'limited'
    : history.monthsObserved < 12 || streams.some((stream) => stream.behavior === 'uncertain' || stream.eventCount < 12)
      ? 'medium'
      : 'high';
  return {
    annualAmount,
    monthlyAmount: annualAmount / 12,
    monthsObserved: history.monthsObserved,
    quality,
    streams,
    historicalAnnualAmount: history.rows.reduce((sum, row) => sum + row.value, 0)
  };
}

export function annualizedLivingSpend(store, trailingMonths = 12) {
  const { transactions, months } = trailingPostedTransactionWindow(store, trailingMonths);
  if (!months.length) {
    return {
      annualSpend: 0,
      monthlyAverage: 0,
      essentialAnnualSpend: 0,
      essentialMonthlySpend: 0,
      monthsObserved: 0
    };
  }
  const factsByMonth = new Map(monthlyFinancialFacts(store).map((fact) => [fact.month, fact]));
  const monthlySpend = months.map((month) => Number(factsByMonth.get(month)?.actualSpend || 0));
  const monthlyEssentials = months.map((month) => Number(factsByMonth.get(month)?.essentialSpend || 0));
  const fullYear = months.length >= 12;
  const annualSpend = fullYear ? monthlySpend.reduce((sum, value) => sum + value, 0) / months.length * 12 : median(monthlySpend) * 12;
  const essentialAnnualSpend = fullYear ? monthlyEssentials.reduce((sum, value) => sum + value, 0) / months.length * 12 : median(monthlyEssentials) * 12;
  return {
    annualSpend,
    monthlyAverage: annualSpend / 12,
    essentialAnnualSpend,
    essentialMonthlySpend: essentialAnnualSpend / 12,
    monthsObserved: months.length,
    completeMonthsObserved: months.length,
    annualizedFromFullYear: fullYear,
    trailingMonths: Math.max(3, Math.min(24, Math.round(Number(trailingMonths) || 12)))
  };
}

function annualizedContributions(store, buckets = ['savings', 'investments'], trailingMonths = 12) {
  const { transactions, months } = trailingPostedTransactionWindow(store, trailingMonths);
  if (!months.length) return { annualContributions: 0, monthlyContributions: 0, monthsObserved: 0 };
  const factsByMonth = new Map(monthlyFinancialFacts(store).map((fact) => [fact.month, fact]));
  const useCashSavings = buckets.length === 1 && buckets[0] === 'savings';
  const monthlyValues = months.map((month) => Number(factsByMonth.get(month)?.[useCashSavings ? 'cashSavings' : 'investmentContributions'] || 0));
  const observedTotal = monthlyValues.reduce((sum, value) => sum + value, 0);
  const fullYear = months.length >= 12;
  const selectedMonths = Math.max(3, Math.min(24, Math.round(Number(trailingMonths) || 12)));
  // A complete selected window represents a usable pace. If history does not
  // yet cover the member's selected window, retain only what was observed so
  // an isolated contribution is never extrapolated into a future promise.
  const annualContributions = months.length >= selectedMonths
    ? observedTotal / months.length * 12
    : observedTotal;
  const monthlyContributions = annualContributions / 12;
  return { annualContributions, monthlyContributions, monthsObserved: months.length, completeMonthsObserved: months.length, annualizedFromFullYear: fullYear };
}

function monthsToTarget({ balance, target, annualContribution = 0, annualReturn = 0 }) {
  if (!Number.isFinite(target) || target <= 0 || balance >= target) return 0;
  const monthlyContribution = Math.max(0, Number(annualContribution || 0)) / 12;
  const monthlyReturn = Number(annualReturn || 0) / 12;
  if (monthlyContribution <= 0 && monthlyReturn <= 0) return null;
  let projected = Math.max(0, Number(balance || 0));
  for (let months = 1; months <= 1200; months += 1) {
    projected = projected * (1 + monthlyReturn) + monthlyContribution;
    if (projected >= target) return months;
  }
  return null;
}

// Coast independence is a moving finish line: every month closer to retirement leaves
// one less month for a portfolio to compound. Project the balance and the
// threshold together so an estimated date is not based on today's frozen
// Coast target.
function monthsToMovingCoastTarget({ balance, retirementTarget, yearsToRetirement, annualContribution = 0, annualReturn = 0 }) {
  if (!Number.isFinite(retirementTarget) || retirementTarget <= 0) return null;
  const contribution = Math.max(0, Number(annualContribution || 0)) / 12;
  const monthlyReturn = Number(annualReturn || 0) / 12;
  const horizonMonths = Math.max(0, Math.floor(Number(yearsToRetirement || 0) * 12));
  const coastTargetAt = (month) => retirementTarget / Math.pow(1 + Number(annualReturn || 0), Math.max(0, (horizonMonths - month) / 12));
  let projected = Math.max(0, Number(balance || 0));

  for (let month = 0; month <= horizonMonths; month += 1) {
    if (projected >= coastTargetAt(month)) return month;
    if (month < horizonMonths) projected = projected * (1 + monthlyReturn) + contribution;
  }
  return null;
}

export function calculateFire(store, netWorth) {
  const settings = store.settings?.fire || {};
  const defaults = { age: 27, retirement_age: 65, withdrawal_rate: 4, real_return: 5, trailing_months: 12 };
  const assumptionsConfigured = settings.assumptions_configured === true
    || ['age', 'retirement_age', 'withdrawal_rate', 'real_return', 'trailing_months'].some((field) => Number(settings[field]) !== defaults[field]);
  const age = Math.max(18, Number(settings.age || 27));
  const retirementAge = Math.max(age, Number(settings.retirement_age || 65));
  const withdrawalRate = Math.max(0, Number(settings.withdrawal_rate ?? 4)) / 100;
  const realReturn = Math.max(-0.9, Number(settings.real_return ?? 5)) / 100;
  const trailingMonths = Math.max(3, Math.min(24, Math.round(Number(settings.trailing_months) || 12)));
  const leanMultiplier = Math.max(1, Number(settings.lean_multiplier || 70)) / 100;
  const fatMultiplier = Math.max(1, Number(settings.fat_multiplier || 150)) / 100;
  const spend = annualizedLivingSpend(store, trailingMonths);
  const contributions = annualizedContributions(store, ['savings', 'investments'], trailingMonths);
  const ongoingContributions = estimateOngoingContributions(store);
  const cashSavings = annualizedContributions(store, ['savings'], trailingMonths);
  const investedAssets = (store.accounts || []).filter((account) => !account.hidden && account.type === 'investment').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const freedomBalance = investedAssets || Math.max(0, Number(netWorth || 0));
  const cashBalance = (store.accounts || []).filter((account) => !account.hidden && account.type === 'depository').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);

  // A 0% withdrawal rate intentionally models a plan that does not draw from
  // this portfolio. Do not silently substitute a small rate or return Infinity.
  const standard = withdrawalRate > 0 && spend.annualSpend > 0 ? spend.annualSpend / withdrawalRate : 0;
  const lean = standard * leanMultiplier;
  const fat = standard * fatMultiplier;
  const essential = withdrawalRate > 0 && spend.essentialAnnualSpend > 0 ? spend.essentialAnnualSpend / withdrawalRate : lean;
  const yearsToRetirement = Math.max(0, retirementAge - age);
  const coast = standard > 0 ? standard / Math.pow(1 + realReturn, yearsToRetirement) : 0;
  const futureValueFactor = realReturn === 0 ? yearsToRetirement : (Math.pow(1 + realReturn, yearsToRetirement) - 1) / realReturn;
  // Retirement outlook uses the exact observed contribution total from the
  // trailing completed 12-month window. Keep recurrence estimation available
  // as metadata, but do not let it remove legitimate windfalls or outliers
  // from the projection input.
  const projectedAtRetirement = freedomBalance * Math.pow(1 + realReturn, yearsToRetirement) + contributions.annualContributions * futureValueFactor;
  const progress = (target, balance = freedomBalance) => target > 0 ? Math.max(0, balance) / target * 100 : 0;
  const emergencyFund = spend.essentialMonthlySpend * 3;
  const runway = spend.essentialMonthlySpend * 6;

  return {
    assumptionsConfigured,
    age,
    retirementAge,
    // Decimal arithmetic can otherwise serialize a clean 7% as
    // 7.000000000000001%. These are user-facing assumptions, so preserve
    // sensible precision at the API boundary.
    withdrawalRate: Number((withdrawalRate * 100).toFixed(2)),
    realReturn: Number((realReturn * 100).toFixed(2)),
    trailingMonths,
    leanMultiplier: leanMultiplier * 100,
    fatMultiplier: fatMultiplier * 100,
    annualSpend: spend.annualSpend,
    monthlySpend: spend.monthlyAverage,
    essentialAnnualSpend: spend.essentialAnnualSpend,
    essentialMonthlySpend: spend.essentialMonthlySpend,
    monthsObserved: spend.monthsObserved,
    completeMonthsObserved: spend.completeMonthsObserved || spend.monthsObserved,
    annualizedFromFullYear: Boolean(spend.annualizedFromFullYear),
    annualContributions: contributions.annualContributions,
    monthlyContributions: contributions.monthlyContributions,
    ongoingAnnualContributions: ongoingContributions.annualAmount,
    ongoingMonthlyContributions: ongoingContributions.monthlyAmount,
    contributionEstimateQuality: ongoingContributions.quality,
    contributionStreams: ongoingContributions.streams,
    contributionMonthsObserved: contributions.monthsObserved,
    investedAssets,
    freedomBalance,
    yearsToRetirement,
    projectedAtRetirement,
    standard,
    lean,
    coast,
    fat,
    lifestyles: [
      { key: 'essential', name: 'Essentials covered', target: essential, detail: 'Housing, food, insurance, and other basics' },
      { key: 'current', name: 'Current lifestyle', target: standard, detail: 'The lifestyle you live today' },
      { key: 'more', name: 'More room', target: fat, detail: 'Extra room for travel, extras, and flexibility' }
    ],
    ladder: [
      { key: 'emergency', name: 'Emergency fund', detail: '3 months of essentials', target: emergencyFund, progress: progress(emergencyFund, cashBalance), complete: cashBalance >= emergencyFund && emergencyFund > 0, estimatedMonths: monthsToTarget({ balance: cashBalance, target: emergencyFund, annualContribution: cashSavings.annualContributions }) },
      { key: 'runway', name: 'Six-month buffer', detail: '6 months of essentials', target: runway, progress: progress(runway, cashBalance), complete: cashBalance >= runway && runway > 0, estimatedMonths: monthsToTarget({ balance: cashBalance, target: runway, annualContribution: cashSavings.annualContributions }) },
      { key: 'coast', name: 'Coast independence', detail: `Amount needed today to fund retirement by age ${retirementAge} without further contributions`, target: coast, progress: progress(coast), complete: freedomBalance >= coast && coast > 0, estimatedMonths: monthsToMovingCoastTarget({ balance: freedomBalance, retirementTarget: standard, yearsToRetirement, annualContribution: contributions.annualContributions, annualReturn: realReturn }) },
      { key: 'standard', name: 'Financial independence', detail: 'Your current lifestyle', target: standard, progress: progress(standard), complete: freedomBalance >= standard && standard > 0, estimatedMonths: monthsToTarget({ balance: freedomBalance, target: standard, annualContribution: contributions.annualContributions, annualReturn: realReturn }) }
    ],
    progress: {
      lean: progress(lean),
      coast: progress(coast),
      standard: progress(standard),
      fat: progress(fat)
    }
  };
}

export function snapshotNetWorth(store, snapshotDate = new Date().toISOString().slice(0, 10)) {
  const summary = summarize(store);
  const date = snapshotDate;
  const existing = store.snapshots.find((s) => s.date === date);
  const snap = { date, assets: summary.assets, liabilities: summary.liabilities, net_worth: summary.netWorth, source: 'verified' };
  if (existing) Object.assign(existing, snap);
  else store.snapshots.push(snap);
  store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (store.snapshots.length > 730) store.snapshots = store.snapshots.slice(-730);
  return snap;
}

export function removeEstimatedNetWorthHistory(store) {
  const before = store.snapshots.length;
  store.snapshots = store.snapshots.filter((snapshot) => snapshot.source === 'verified');
  return store.snapshots.length !== before;
}

function refreshDemoAccountLabels(store) {
  const now = new Date().toISOString();
  const chase = store.accounts.find((account) => account.id === 'demo-credit');
  // Upgrade older demo snapshots without overwriting a person’s optional
  // sample nickname. These are recognizable products, not generic labels.
  if (chase && !chase.nickname) {
    chase.name = 'Chase Sapphire Preferred';
    chase.mask ||= '4821';
    chase.interest_rate ??= 24.49;
  }
  if (!store.accounts.some((account) => account.id === 'demo-venture')) {
    store.accounts.push({ id: 'demo-venture', item_id: 'demo-capital-one', plaid_account_id: 'demo-venture', institution_name: 'Capital One', name: 'Capital One Venture', type: 'credit', subtype: 'credit card', current_balance: 640, interest_rate: 19.99, interest_rate_source: 'institution', mask: '6108', updated_at: now, demo: true });
  }
}

function demoNetWorthFromAccounts(store) {
  return (store.accounts || []).reduce((total, account) => {
    const balance = Math.abs(Number(account.current_balance || 0));
    return total + (accountSide(account.type) === 'liability' ? -balance : balance);
  }, 0);
}

function demoInvestmentBalance(store) {
  return (store.accounts || [])
    .filter((account) => account.demo && account.type === 'investment')
    .reduce((total, account) => total + Math.abs(Number(account.current_balance || 0)), 0);
}

// Creates fixture records once, before any view range is selected. The small
// independent variations are deliberately stored in the records, rather than
// drawn by a chart, and the final observation reconciles to the account value.
function seededGrowthSeries({ count, start, end, seed, intervalsPerMonth = 1 }) {
  let state = seed;
  let value = start;
  const raw = Array.from({ length: count }, (_, index) => {
    state = (state * 16_807) % 2_147_483_647;
    const variation = state / 2_147_483_647 - .5;
    // Contributions keep a diversified household's long-horizon balance from
    // performing like a price-only ticker while avoiding synthetic waves.
    const contribution = (320 + variation * 110) / intervalsPerMonth;
    // A daily fixture has smaller per-observation movement than a monthly
    // fixture. That produces a plausible recorded path without a synthetic
    // sawtooth or a chart-side interpolation.
    value = value * (1 + .0038 / intervalsPerMonth + variation * .004 / Math.sqrt(intervalsPerMonth)) + contribution;
    return value;
  });
  const span = Math.max(.01, raw.at(-1) - raw[0]);
  return raw.map((point) => Math.round(start + (point - raw[0]) * (end - start) / span));
}

export function seedDemo(store) {
  // Demo is a complete, representative plan rather than an empty shell. Keep
  // this separate from a member's real settings: activeStore/demoPreviewStore
  // create their own demo-mode settings object before calling this function.
  if (store.settings?.demo_mode && !(store.settings.goals || []).length) {
    store.settings.goals = [{
      id: 'demo-emergency-fund', name: 'Emergency fund', source: 'cash',
      target: 30_000, created_at: '2026-01-01T00:00:00.000Z', demo: true
    }];
  }
  if (store.accounts.length || store.transactions.length || store.snapshots.length) {
    if (store.accounts.length && store.accounts.every((account) => account.demo)) {
      refreshDemoAccountLabels(store);
      addDemoHistory(store);
      ensureDemoMarketHistory(store);
    }
    return store;
  }
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const d = (day) => `${month}-${String(day).padStart(2, '0')}`;
  // These are deliberately local demo records—not Plaid Items. They make the
  // sample Profile view agree with the accounts shown throughout the demo
  // without suggesting that a visitor has linked any real institution.
  store.items = [
    { id: 'demo-chase', institution_name: 'Chase', demo: true },
    { id: 'demo-ally', institution_name: 'Ally', demo: true },
    { id: 'demo-fidelity', institution_name: 'Fidelity', demo: true },
    { id: 'demo-capital-one', institution_name: 'Capital One', demo: true }
  ];
  store.accounts = [
    { id: 'demo-checking', item_id: 'demo-chase', plaid_account_id: 'demo-checking', institution_name: 'Chase', name: 'Checking', type: 'depository', subtype: 'checking', current_balance: 5200, available_balance: 5000, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-hysa', item_id: 'demo-ally', plaid_account_id: 'demo-hysa', institution_name: 'Ally', name: 'High Yield Savings', type: 'depository', subtype: 'savings', current_balance: 12500, available_balance: 12500, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-brokerage', item_id: 'demo-fidelity', plaid_account_id: 'demo-brokerage', institution_name: 'Fidelity', name: 'Brokerage', type: 'investment', subtype: 'brokerage', current_balance: 18200, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-roth', item_id: 'demo-fidelity', plaid_account_id: 'demo-roth', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', current_balance: 26378, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-401k', item_id: 'demo-fidelity', plaid_account_id: 'demo-401k', institution_name: 'Fidelity', name: '401(k)', type: 'investment', subtype: '401k', current_balance: 43810, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-credit', item_id: 'demo-chase', plaid_account_id: 'demo-credit', institution_name: 'Chase', name: 'Chase Sapphire Preferred', type: 'credit', subtype: 'credit card', current_balance: 1160, interest_rate: 24.49, interest_rate_source: 'institution', mask: '4821', updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-venture', item_id: 'demo-capital-one', plaid_account_id: 'demo-venture', institution_name: 'Capital One', name: 'Capital One Venture', type: 'credit', subtype: 'credit card', current_balance: 640, interest_rate: 19.99, interest_rate_source: 'institution', mask: '6108', updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-auto', item_id: 'demo-capital-one', plaid_account_id: 'demo-auto', institution_name: 'Capital One', name: 'Auto loan', type: 'loan', subtype: 'auto', current_balance: 9350, interest_rate: 5.9, interest_rate_source: 'institution', updated_at: new Date().toISOString(), demo: true }
  ];
  // A simple three-fund portfolio with a small cash position. Each displayed
  // account balance exactly reconciles to these concrete demo holdings.
  store.positions = [
    ['demo-brokerage', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 34, 274, 9316],
    ['demo-brokerage', 'VXUS', 'Vanguard Total International Stock ETF', 'etf', 50, 65, 3250],
    ['demo-brokerage', 'BND', 'Vanguard Total Bond Market ETF', 'etf', 50, 73, 3650],
    ['demo-brokerage', 'SPAXX', 'Fidelity Government Money Market Fund', 'cash', 1984, 1, 1984],
    ['demo-roth', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 60, 274, 16440],
    ['demo-roth', 'VXUS', 'Vanguard Total International Stock ETF', 'etf', 90, 65, 5850],
    ['demo-roth', 'BND', 'Vanguard Total Bond Market ETF', 'etf', 56, 73, 4088],
    ['demo-401k', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 95, 274, 26030],
    ['demo-401k', 'VXUS', 'Vanguard Total International Stock ETF', 'etf', 150, 65, 9750],
    ['demo-401k', 'BND', 'Vanguard Total Bond Market ETF', 'etf', 110, 73, 8030]
  ].map(([account_id, ticker, name, type, quantity, price, value]) => ({ id: `demo-position-${ticker}-${account_id}`, item_id: 'demo-fidelity', account_id, security_id: `demo-security-${ticker}`, ticker, name, type, quantity, price, value, cost_basis: Math.round(value * .9), demo: true }));
  ensureDemoMarketHistory(store);
  const rows = [
    ['payroll-1', 'Payroll', -3100, d(1), 'income'],
    ['hysa-interest', 'Ally Savings interest', -42.65, d(1), 'income'],
    ['rent', 'Rent', 1650, d(1), 'fixed'],
    ['brokerage-transfer', 'Fidelity Brokerage', 350, d(2), 'investments'],
    ['hysa-transfer', 'Ally Savings', 250, d(2), 'savings'],
    ['groceries-1', 'Trader Joe’s', 132.48, d(3), 'fixed'],
    ['restaurant-1', 'Din Tai Fung', 84.76, d(4), 'guilt_free'],
    ['internet', 'Google Fiber', 70, d(5), 'fixed'],
    ['gym', 'Gym Membership', 45, d(6), 'fixed'],
    ['shopping', 'Uniqlo', 126.40, d(7), 'guilt_free'],
    ['coffee', 'Coffee Shop', 8.75, d(8), 'guilt_free'],
    ['gas', 'Shell', 58.20, d(9), 'fixed'],
    ['credit-payment', 'Credit Card Payment', 1600, d(10), 'transfer'],
    ['payroll-2', 'Payroll', -3100, d(15), 'income'],
    ['groceries-2', 'Costco', 184.29, d(16), 'fixed'],
    ['flight', 'Southwest Airlines', 286.12, d(18), 'guilt_free'],
    ['utilities', 'SDG&E', 151.60, d(20), 'fixed'],
    ['restaurant-2', 'Sushi', 112.30, d(21), 'guilt_free']
  ];
  const demoPfc = (merchant) => /Rent|Fiber|SDG|Gym/.test(merchant) ? 'RENT_AND_UTILITIES' : /Trader|Costco|Sushi|Coffee/.test(merchant) ? 'FOOD_AND_DRINK' : /Shell/.test(merchant) ? 'TRANSPORTATION' : /Uniqlo/.test(merchant) ? 'GENERAL_MERCHANDISE' : /Southwest/.test(merchant) ? 'TRAVEL' : '';
  store.transactions = rows.map(([id, merchant, amount, date, bucket]) => ({
    id, plaid_transaction_id: id, account_id: /Ally Savings interest/.test(merchant) ? 'demo-hysa' : amount < 0 ? 'demo-checking' : 'demo-credit',
    merchant_name: merchant, name: merchant, amount, date, bucket, excluded: false, pending: false,
    pfc_primary: /Ally Savings interest/.test(merchant) ? 'INCOME' : demoPfc(merchant),
    pfc_detailed: /Ally Savings interest/.test(merchant) ? 'INCOME_INTEREST_EARNED' : '', demo: true
  }));
  store.transactions.push({
    id: 'demo-401k-contribution', plaid_transaction_id: 'demo-401k-contribution', account_id: 'demo-401k',
    // Keep the current demo's payroll contribution posted, rather than
    // accidentally placing it later in the current calendar month.
    merchant_name: '401(k) employee contribution', name: '401(k) employee contribution', amount: 300, date: d(2),
    bucket: 'investments', excluded: false, pending: false, pfc_primary: 'RETIREMENT_CONTRIBUTION',
    pfc_detailed: '', source: 'investment_transaction', demo: true
  });

  addDemoHistory(store);
  return store;
}

function ensureDemoMarketHistory(store) {
  store.market_prices ||= {};
  // Rebuild the isolated demo fixture whenever its coverage changes. These
  // rows never coexist with a member's encrypted financial records.
  store.investment_position_snapshots = (store.investment_position_snapshots || []).filter((record) => !record.demo);
  const snapshotKeys = new Set(store.investment_position_snapshots.map((record) => `${record.date}|${record.kind}|${record.key}`));
  store.investment_transactions ||= [];
  const today = new Date();
  const demoHistoryDays = 84 * 30;
  // Reconcile account totals to holdings before recording history. This avoids
  // presenting a made-up "Cash & unclassified" allocation residual.
  for (const account of store.accounts || []) {
    if (!account.demo || account.type !== 'investment') continue;
    const holdings = (store.positions || []).filter((position) => position.account_id === account.plaid_account_id);
    if (holdings.length) account.current_balance = Math.round(holdings.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0) * 100) / 100;
  }
  const byTicker = new Map();
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    byTicker.set(position.ticker, Number(position.price || (Number(position.value || 0) / Math.max(1, Number(position.quantity || 1)))));
  }
  for (const [ticker, currentPrice] of byTicker) {
    const prices = store.market_prices[ticker] ||= {};
    if (Object.keys(prices).length >= demoHistoryDays) continue;
    for (const date of Object.keys(prices)) delete prices[date];
    let priceSeed = [...ticker].reduce((sum, character) => sum * 31 + character.charCodeAt(0), 19) % 2_147_483_647;
    let simulatedPrice = currentPrice * .48;
    const simulated = [];
    for (let index = 0; index <= demoHistoryDays; index += 1) {
      priceSeed = (priceSeed * 16_807) % 2_147_483_647;
      const variation = priceSeed / 2_147_483_647 - .5;
      simulatedPrice *= 1 + .00028 + variation * .005;
      simulated.push(simulatedPrice);
    }
    const normalize = currentPrice / simulated.at(-1);
    for (let day = demoHistoryDays; day >= 0; day -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - day);
      const index = demoHistoryDays - day;
      prices[date.toISOString().slice(0, 10)] = Math.round(simulated[index] * normalize * 100) / 100;
    }
  }
  // Demo-only acquisition records keep its personal-history chart internally
  // consistent with the same conservative rules used for real connections.
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    const id = `demo-trade-${position.account_id}-${position.ticker}`;
    if (store.investment_transactions.some((transaction) => transaction.id === id)) continue;
    const date = new Date(today);
    date.setFullYear(date.getFullYear() - 7);
    store.investment_transactions.push({ id, account_id: position.account_id, security_id: position.security_id || null, ticker: position.ticker, security_type: position.type, date: date.toISOString().slice(0, 10), quantity: Number(position.quantity || 0), price: Number(position.price || 0), amount: Number(position.value || 0), type: 'buy', subtype: 'buy', demo: true });
  }
  // The public preview is explicitly synthetic. Give it a consistent personal
  // chart without ever sharing this data with an authenticated person.
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    for (const [date, price] of Object.entries(store.market_prices[position.ticker] || {})) {
      const key = position.id || `${position.account_id}:${position.ticker}`;
      const snapshotKey = `${date}|holding|${key}`;
      if (snapshotKeys.has(snapshotKey)) continue;
      store.investment_position_snapshots.push({ date, kind: 'holding', key, account_id: position.account_id, security_id: position.security_id || null, ticker: position.ticker, quantity: Number(position.quantity || 0), price: Number(price || 0), value: Math.round(Number(position.quantity || 0) * Number(price || 0) * 100) / 100, source: 'verified', demo: true });
      snapshotKeys.add(snapshotKey);
    }
  }
  // Account detail charts use the exact same daily holding observations as the
  // holdings list. Cash is a $1 holding, so no balancing multiplier is needed.
  for (const account of (store.accounts || []).filter((entry) => entry.demo && entry.type === 'investment')) {
    const holdings = (store.positions || []).filter((position) => position.account_id === account.plaid_account_id);
    for (let day = demoHistoryDays; day >= 0; day -= 1) {
      const date = new Date(today); date.setDate(today.getDate() - day);
      const dayKey = date.toISOString().slice(0, 10);
      const snapshotKey = `${dayKey}|account|${account.plaid_account_id}`;
      if (snapshotKeys.has(snapshotKey)) continue;
      const value = holdings.reduce((sum, position) => {
        const price = position.type === 'cash' ? Number(position.price || 1) : Number(store.market_prices?.[position.ticker]?.[dayKey] || position.price || 0);
        return sum + Math.abs(Number(position.quantity || 0) * price);
      }, 0);
      store.investment_position_snapshots.push({ date: dayKey, kind: 'account', key: account.plaid_account_id, account_id: account.plaid_account_id, value: Math.round(value * 100) / 100, source: 'verified', demo: true });
      snapshotKeys.add(snapshotKey);
    }
  }
  store.investment_position_snapshots.sort((a, b) => a.date.localeCompare(b.date));
  // The overview must use exactly the same daily account observations as its
  // account drill-downs. A monthly synthetic aggregate made a scrub appear to
  // skip days even though the demo already had daily reported values.
  const investmentAccountIds = new Set((store.accounts || [])
    .filter((account) => account.demo && account.type === 'investment')
    .map((account) => account.plaid_account_id));
  const portfolioByDate = new Map();
  for (const record of store.investment_position_snapshots) {
    if (!record.demo || record.source !== 'verified' || record.kind !== 'account' || !investmentAccountIds.has(record.account_id)) continue;
    portfolioByDate.set(record.date, (portfolioByDate.get(record.date) || 0) + Math.abs(Number(record.value || 0)));
  }
  store.investment_snapshots = [...portfolioByDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, value: Math.round(value * 100) / 100, source: 'verified', demo: true }));
}

function addDemoHistory(store) {
  const now = new Date();
  const existingTransactionIds = new Set(store.transactions.map((transaction) => transaction.id));
  // The demo is an internally consistent data fixture. Keep one stored point
  // per day so chart scrubbing has the same fidelity as a long-running member
  // account; the UI never invents values between these records.
  const historyMonths = 84;
  const historyDays = historyMonths * 30;
  const demoStartingNetWorth = 26000;
  const historyEnd = Number(demoNetWorthFromAccounts(store));
  const values = seededGrowthSeries({ count: historyDays, start: demoStartingNetWorth, end: historyEnd, seed: 55_319, intervalsPerMonth: 30 });
  const endingLiabilities = 11_350;
  const startingLiabilities = 16_500;
  const demoSnapshots = values.map((netWorth, index) => {
    const date = new Date(now);
    date.setDate(now.getDate() - (values.length - 1 - index));
    const progress = values.length <= 1 ? 1 : index / (values.length - 1);
    const liabilities = Math.round(startingLiabilities - progress * (startingLiabilities - endingLiabilities));
    const roundedNetWorth = Math.round(netWorth);
    return { date: date.toISOString().slice(0, 10), assets: roundedNetWorth + liabilities, liabilities, net_worth: roundedNetWorth, source: 'verified', demo: true };
  });
  // Demo is an isolated store, but preserve the invariant if this helper is
  // ever reused with non-demo records present.
  store.snapshots = [...store.snapshots.filter((snapshot) => !snapshot.demo), ...demoSnapshots];
  for (let monthsAgo = 1; monthsAgo <= historyMonths; monthsAgo += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const month = date.toISOString().slice(0, 7);
    const variation = Math.round(Math.sin(monthsAgo * 1.7) * 110);
    // Groceries and dining are repeat spending categories, not subscriptions.
    // Vary their merchants in the sample so the recurring card teaches the
    // right mental model: bills and opt-in subscriptions.
    const groceryMerchant = ['Trader Joe’s', 'Costco', 'Whole Foods'][monthsAgo % 3];
    const leisureMerchant = ['Dinner with friends', 'Local weekend plans', 'Coffee & treats'][monthsAgo % 3];
    const rows = [
      ['payroll', 'Payroll', -6200, 'income', 'demo-checking', 'INCOME'],
      ['interest', 'Ally Savings interest', -(38 + monthsAgo % 6), 'income', 'demo-hysa', 'INCOME'],
      ['rent', 'Rent', 1650, 'fixed', 'demo-credit', 'RENT_AND_UTILITIES'],
      ['essentials', groceryMerchant, 690 + variation, 'fixed', 'demo-credit', 'FOOD_AND_DRINK'],
      ['saving', 'Ally Savings', 250, 'savings', 'demo-credit', 'TRANSFER_IN'],
      ['investing', 'Fidelity Brokerage', 350, 'investments', 'demo-credit', 'INVESTMENT'],
      ['flex', leisureMerchant, 520 - variation, 'guilt_free', 'demo-credit', 'ENTERTAINMENT'],
      ['netflix', 'Netflix', 22.99, 'guilt_free', 'demo-credit', 'ENTERTAINMENT'],
      ['spotify', 'Spotify Premium', 11.99, 'guilt_free', 'demo-credit', 'ENTERTAINMENT'],
      ['icloud', 'iCloud+', 2.99, 'fixed', 'demo-credit', 'GENERAL_SERVICES']
    ];
    for (const [kind, merchant, amount, bucket, accountId, pfcPrimary] of rows) {
      const id = `demo-history-${month}-${kind}`;
      if (existingTransactionIds.has(id)) continue;
      store.transactions.push({
        id, plaid_transaction_id: id, account_id: accountId, merchant_name: merchant, name: merchant,
        amount, date: `${month}-15`, bucket, excluded: false, pending: false,
        pfc_primary: pfcPrimary, pfc_detailed: '', demo: true
      });
    }
    const contributionId = `demo-history-${month}-401k`;
    if (!existingTransactionIds.has(contributionId)) {
      store.transactions.push({
        id: contributionId, plaid_transaction_id: contributionId, account_id: 'demo-401k',
        merchant_name: '401(k) employee contribution', name: '401(k) employee contribution', amount: 300,
        date: `${month}-15`, bucket: 'investments', excluded: false, pending: false,
        pfc_primary: 'RETIREMENT_CONTRIBUTION', pfc_detailed: '', source: 'investment_transaction', demo: true
      });
    }
  }
  store.transactions.sort((a, b) => a.date.localeCompare(b.date));
  store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
}
