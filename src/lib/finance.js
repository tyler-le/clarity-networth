export function classifyTransaction(tx) {
  const primary = (tx.personal_finance_category?.primary || '').toUpperCase();
  const detailed = (tx.personal_finance_category?.detailed || '').toUpperCase();
  const name = `${tx.merchant_name || ''} ${tx.name || ''}`.toUpperCase();

  if (tx.amount < 0 && (primary.includes('INCOME') || detailed.includes('INCOME') || name.includes('PAYROLL'))) {
    return 'income';
  }

  if (detailed.includes('INVESTMENT') || detailed.includes('RETIREMENT')) return 'investments';
  if (detailed.includes('SAVINGS')) return 'savings';

  if (
    primary.includes('TRANSFER') ||
    detailed.includes('TRANSFER') ||
    detailed.includes('CREDIT_CARD_PAYMENT') ||
    name.includes('PAYMENT THANK YOU') ||
    name.includes('AUTOPAY PAYMENT')
  ) return 'transfer';

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

export function investmentSummary(store) {
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
  return {
    total,
    accounts: accounts.map((account) => ({ id: account.id, account_id: account.plaid_account_id, name: account.nickname || account.name, institution_name: account.institution_name, subtype: account.subtype, value: Math.abs(Number(account.current_balance || 0)) })),
    allocation: allocationRows,
    unclassifiedAccounts,
    positions: positions.map((position) => ({ ...position, gain: position.cost_basis == null ? null : Number(position.value || 0) - Number(position.cost_basis), gain_pct: position.cost_basis ? (Number(position.value || 0) - Number(position.cost_basis)) / Number(position.cost_basis) : null })).sort((a, b) => Number(b.value || 0) - Number(a.value || 0)),
    snapshots: (store.investment_snapshots || []).slice(-3650),
    historyStatus: store.investment_history_status || { state: 'tracking', unavailable: [] },
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
  // A reconciled reconstruction is retained until a provider-observed value
  // supersedes it for the same day. Nothing inferred without reconciliation
  // is allowed into this timeline.
  store.investment_snapshots = (store.investment_snapshots || []).filter((snapshot) => ['verified', 'reconstructed'].includes(snapshot.source));
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
  for (const account of accounts) upsert({ date: snapshotDate, kind: 'account', key: account.plaid_account_id, account_id: account.plaid_account_id, value: Math.abs(Number(account.current_balance || 0)), source: 'verified' });
  for (const position of (store.positions || []).filter((position) => !position.hidden && accounts.some((account) => account.plaid_account_id === position.account_id))) {
    upsert({ date: snapshotDate, kind: 'holding', key: position.id || `${position.account_id}:${position.security_id || position.ticker || position.name}`, account_id: position.account_id, ticker: String(position.ticker || '').toUpperCase() || null, value: Math.abs(Number(position.value || 0)), source: 'verified' });
  }
  store.investment_position_snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (store.investment_position_snapshots.length > 20_000) store.investment_position_snapshots = store.investment_position_snapshots.slice(-20_000);
}

function providerPositionHistory(store, { accountId = null, ticker = null } = {}) {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const records = (store.investment_position_snapshots || []).filter((record) => {
    if (record.source !== 'verified') return false;
    if (accountId) return record.kind === 'account' && record.account_id === accountId;
    return record.kind === 'holding' && record.ticker === normalizedTicker;
  });
  const totals = new Map();
  for (const record of records) totals.set(record.date, (totals.get(record.date) || 0) + Number(record.value || 0));
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

// Some institutions send a display label in place of a tradable target-date
// fund ticker. Historical pricing needs a real ticker to build a timeline.
export function historicalTicker(ticker, securityName = '') {
  const rawTicker = String(ticker || '').trim();
  const text = `${rawTicker} ${securityName}`.toLowerCase();
  const targetRetirementTickers = {
    2020: 'VTWNX', 2025: 'VTTVX', 2030: 'VTHRX', 2035: 'VTTHX', 2040: 'VFORX',
    2045: 'VTIVX', 2050: 'VFIFX', 2055: 'VFFVX', 2060: 'VTTSX', 2065: 'VLXVX', 2070: 'VSVNX'
  };
  const match = text.match(/vanguard\s+target(?:\s+retirement)?\s+(20\d{2})/i);
  return match && targetRetirementTickers[match[1]] ? targetRetirementTickers[match[1]] : rawTicker;
}

export function historicalSecurity({ ticker, name = '', type = 'other' } = {}) {
  const resolvedTicker = historicalTicker(ticker, name);
  const targetDateFund = resolvedTicker !== String(ticker || '').trim() && /vanguard\s+target/i.test(`${ticker || ''} ${name}`);
  return { ticker: resolvedTicker, type: targetDateFund ? 'mutual fund' : type };
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

function reconstructReportedPositions(store, positions, { endDate = new Date().toISOString().slice(0, 10), years = 1, expectedValue = null } = {}) {
  if (!positions.length || positions.some((position) => position.type === 'cash' || !position.security_id || !position.ticker || !Number.isFinite(Number(position.quantity)) || Number(position.quantity) < 0)) return { state: 'unavailable', reason: 'Your institution did not provide enough priced holding detail to verify a reconstruction.', history: [] };
  const relevant = (store.investment_transactions || []).filter((transaction) => transaction.date <= endDate && positions.some((position) => transactionMatchesPosition(transaction, position)));
  const firstTradeByPosition = positions.map((position) => relevant.filter((transaction) => transactionMatchesPosition(transaction, position) && Number.isFinite(Number(transaction.quantity)) && Number(transaction.quantity) !== 0).map((transaction) => transaction.date).filter(Boolean).sort()[0]);
  if (firstTradeByPosition.some((date) => !date)) return { state: 'unavailable', reason: 'Your institution did not provide reported activity for every current holding.', history: [] };
  const start = new Date(`${[...firstTradeByPosition].sort().at(-1)}T12:00:00`);
  const requested = new Date(`${endDate}T12:00:00`);
  requested.setFullYear(requested.getFullYear() - Math.max(1, Math.min(2, Number(years) || 1)));
  if (start < requested) start.setTime(requested.getTime());
  const history = [];
  for (const cursor = new Date(start); cursor <= new Date(`${endDate}T12:00:00`); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = cursor.toISOString().slice(0, 10);
    let value = 0;
    for (const position of positions) {
      const laterQuantity = relevant.filter((transaction) => transactionMatchesPosition(transaction, position) && transaction.date > date).reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0);
      const quantity = Number(position.quantity || 0) - laterQuantity;
      if (!Number.isFinite(quantity) || quantity < -.000001) return { state: 'unavailable', reason: 'Reported activity does not reconcile to the current quantity.', history: [] };
      if (quantity <= .000001) continue;
      const price = nearestPrice(store.market_prices?.[String(position.ticker).toUpperCase()], date);
      if (!Number.isFinite(price)) return { state: 'unavailable', reason: 'A historical price needed to verify this position is unavailable.', history: [] };
      value += quantity * price;
    }
    history.push({ date, value: Math.round(value * 100) / 100, source: 'reconstructed' });
  }
  if (history.length < 2) return { state: 'unavailable', reason: 'There is not enough reported activity for a useful personal history.', history: [] };
  const target = Number(expectedValue == null ? positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0) : expectedValue);
  const difference = Math.abs(Number(history.at(-1).value || 0) - target);
  if (!Number.isFinite(target) || difference > reconstructionTolerance(target)) return { state: 'unavailable', reason: 'The reconstructed value does not closely match the latest institution value.', history: [] };
  return { state: 'ready', history, startDate: history[0].date, difference };
}

// Rebuild only derived snapshots from the evidence we already hold. This is
// safe to call while rendering: it makes no provider request, retains truly
// observed daily balances, and removes a prior reconstruction when its
// coverage is no longer supportable.
export function refreshReconstructedInvestmentSnapshots(store, endDate = new Date().toISOString().slice(0, 10), years = 1) {
  // A prior reconstruction is never allowed to outlive the evidence that
  // justified it. Re-add it below only after every visible account passes.
  store.investment_snapshots = (store.investment_snapshots || []).filter((snapshot) => snapshot.source === 'verified');
  const accounts = (store.accounts || []).filter((account) => account.type === 'investment' && !account.hidden);
  const reconstructed = [];
  for (const account of accounts) {
    const positions = (store.positions || []).filter((position) => position.account_id === account.plaid_account_id && !position.hidden);
    const positionValue = positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
    if (Math.abs(positionValue - Math.abs(Number(account.current_balance || 0))) > reconstructionTolerance(account.current_balance)) return [];
    const result = reconstructReportedPositions(store, positions, { endDate, years, expectedValue: positionValue });
    if (result.state !== 'ready') return [];
    reconstructed.push(result.history);
  }
  if (!reconstructed.length) return [];
  const sharedDates = reconstructed.map((history) => new Set(history.map((row) => row.date))).reduce((common, dates) => new Set([...common].filter((date) => dates.has(date))));
  const combined = [...sharedDates].sort().map((date) => ({ date, value: Math.round(reconstructed.reduce((sum, history) => sum + Number(history.find((row) => row.date === date)?.value || 0), 0) * 100) / 100, source: 'reconstructed' }));
  if (combined.length < 2) return [];
  const verified = store.investment_snapshots;
  const verifiedDates = new Set(verified.map((snapshot) => snapshot.date));
  store.investment_snapshots = [...combined.filter((snapshot) => !verifiedDates.has(snapshot.date)), ...verified].sort((a, b) => a.date.localeCompare(b.date));
  return combined;
}

// A detail chart is intentionally more conservative than a ticker chart. It
// reconstructs the person's currently reported quantity from available trades
// and historical prices, but never labels a missing trade record as a gain.
export function investmentDetailHistory(store, { accountId = null, ticker = null, years = 1 } = {}) {
  const visibleAccounts = new Set(store.accounts.filter((account) => !account.hidden && account.type === 'investment').map((account) => account.plaid_account_id));
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const positions = (store.positions || []).filter((position) => {
    if (!visibleAccounts.has(position.account_id) || position.hidden) return false;
    if (accountId) return position.account_id === accountId;
    return normalizedTicker && String(position.ticker || '').trim().toUpperCase() === normalizedTicker;
  });
  if (!positions.length) return { state: 'unavailable', reason: 'This holding is not available from your latest connection.', history: [], market: [] };
  const resolvedTickers = [...new Set(positions.map((position) => String(position.ticker || '').trim().toUpperCase()).filter(Boolean))];
  const value = positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  const completeCostBasis = positions.every((position) => position.cost_basis != null);
  const costBasis = completeCostBasis ? positions.reduce((sum, position) => sum + Number(position.cost_basis || 0), 0) : null;
  const label = accountId
    ? (store.accounts.find((account) => account.plaid_account_id === accountId)?.nickname || store.accounts.find((account) => account.plaid_account_id === accountId)?.name || 'Investment account')
    : (positions[0].name || normalizedTicker);
  const providerHistory = providerPositionHistory(store, { accountId, ticker: normalizedTicker });
  if (providerHistory.length < 2) {
    const itemIds = new Set((store.accounts || []).filter((account) => positions.some((position) => position.account_id === account.plaid_account_id)).map((account) => account.item_id));
    if ((store.items || []).some((item) => itemIds.has(item.id) && item.investment_history_state === 'preparing')) return {
      state: 'unavailable', label, ticker: resolvedTickers.length === 1 ? resolvedTickers[0] : null, value,
      costBasis, gain: costBasis == null ? null : value - costBasis, history: [], market: [],
      reason: 'Your institution is still preparing its reported investment activity. We will only build a chart after the complete activity is available.'
    };
    const reconstructed = reconstructReportedPositions(store, positions, { years, expectedValue: value });
    if (reconstructed.state === 'ready') return {
      state: 'ready', label, ticker: resolvedTickers.length === 1 ? resolvedTickers[0] : null, value,
      costBasis, gain: costBasis == null ? null : value - costBasis,
      gainPct: costBasis ? (value - costBasis) / costBasis : null,
      history: reconstructed.history, market: [], reconstructed: true,
      detail: `Reconstructed from reported institution activity beginning ${reconstructed.startDate}; it matches your latest institution value.`
    };
    return {
      state: 'unavailable', label, ticker: resolvedTickers.length === 1 ? resolvedTickers[0] : null, value,
      costBasis, gain: costBasis == null ? null : value - costBasis, history: [], market: [],
      reason: reconstructed.reason
    };
  }
  return {
    state: 'ready', label, ticker: resolvedTickers.length === 1 ? resolvedTickers[0] : null, value,
    costBasis, gain: costBasis == null ? null : value - costBasis,
    gainPct: costBasis ? (value - costBasis) / costBasis : null,
    history: providerHistory, market: [],
    detail: `Based on ${providerHistory.length} verified updates from your connected institution.`
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
    const explicitAt = item.last_synced_at ? new Date(item.last_synced_at).getTime() : 0;
    const syncedAt = Number.isFinite(explicitAt) && explicitAt > 0 ? explicitAt : inferredAt;
    const failureCount = Number(item.sync_failure_count || (item.last_sync_error_at ? 1 : 0));
    // Escalate only after three consecutive full-refresh failures. A single
    // failed daily attempt is retried automatically and should stay quiet.
    const state = item.requires_reconnect || failureCount >= 3 ? 'attention' : syncedAt < staleCutoff ? 'stale' : 'healthy';
    return {
      id: item.id,
      institution_name: item.institution_name,
      last_synced_at: item.last_synced_at || (syncedAt ? new Date(syncedAt).toISOString() : null),
      failure_count: failureCount,
      requires_reconnect: Boolean(item.requires_reconnect),
      state
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


function spendingPeriod(range, anchor = new Date()) {
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

function cashFlowDetail(transaction) {
  if (transaction.bucket === 'savings') return { key: 'savings', label: 'Save', group: 'savings' };
  if (transaction.bucket === 'investments') return { key: 'investments', label: 'Invest', group: 'investments' };
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

// Plaid's income category is intentionally broad. Keep the main cash-flow
// calculation broad too, but retain the source so a paycheck is not made to
// look indistinguishable from HYSA interest, benefits, or self-employment.
function incomeSource(transaction) {
  const primary = String(transaction.pfc_primary || '').toUpperCase();
  const detailed = String(transaction.pfc_detailed || '').toUpperCase();
  const name = `${transaction.merchant_name || ''} ${transaction.name || ''}`.toUpperCase();
  const context = `${primary} ${detailed} ${name}`;
  if (/INTEREST/.test(context)) return { key: 'income_interest', label: 'Interest' };
  if (/DIVIDEND/.test(context)) return { key: 'income_dividends', label: 'Dividends' };
  if (/PAYROLL|SALARY|WAGE/.test(context)) return { key: 'income_paychecks', label: 'Paychecks' };
  if (/BENEFIT|UNEMPLOYMENT|SOCIAL_SECURITY|PENSION/.test(context)) return { key: 'income_benefits', label: 'Benefits' };
  if (/FREELANCE|CONTRACT|BUSINESS|GIG/.test(context)) return { key: 'income_business', label: 'Business & freelance' };
  return { key: 'income_other', label: 'Other income' };
}

export function spendingSummary(store, range = '1m', anchor = new Date()) {
  const { startDate, endDate, completedMonths } = spendingPeriod(range, anchor);
  const categories = new Map();
  const merchants = new Map();
  const monthly = new Map();
  const monthlyIncome = new Map();
  const monthlyPreTaxRetirement = new Map();
  const incomeSourceMap = new Map();
  const transactionRows = [];
  const actualSpendCategoryMap = new Map();
  let actualSpend = 0;
  let savings = 0;
  let investments = 0;
  let savingsAndInvestments = 0;
  const incomeTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || transaction.bucket !== 'income') return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
  for (const transaction of incomeTransactions) {
    const month = String(transaction.date).slice(0, 7);
    const amount = Math.abs(Number(transaction.amount || 0));
    const source = incomeSource(transaction);
    monthlyIncome.set(month, (monthlyIncome.get(month) || 0) + amount);
    incomeSourceMap.set(source.key, { ...source, amount: (incomeSourceMap.get(source.key)?.amount || 0) + amount });
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: transaction.merchant_name || transaction.name || 'Income',
      date: transaction.date,
      amount,
      category: source.label,
      bucket: 'income',
      flowKey: source.key,
      flowLabel: source.label,
      flowGroup: 'income'
    });
  }
  // Payroll retirement deferrals are pre-tax: they never arrive in a checking
  // account, so including them in money out would compare gross savings with
  // net take-home income. Keep them visible, but outside cash flow.
  const preTaxRetirementTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || transaction.source !== 'investment_transaction' || transaction.bucket !== 'investments') return false;
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
    if (transaction.pending || transaction.excluded || transaction.bucket === 'transfer' || (transaction.source === 'investment_transaction' && transaction.bucket === 'investments') || Number(transaction.amount || 0) <= 0) return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
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
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: merchant,
      date: transaction.date,
      amount,
      category,
      bucket: transaction.bucket,
      flowKey: flow.key,
      flowLabel: flow.label,
      flowGroup: flow.group
    });
  }
  const total = [...categories.values()].reduce((sum, amount) => sum + amount, 0);
  const categoryRows = [...categories.entries()]
    .map(([name, amount]) => ({ name, amount, share: total ? amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
  // Allocate the leftover percentage points by largest remainder so the UI
  // always reconciles to 100%, rather than showing independently rounded values.
  const wholePercent = categoryRows.map((row) => Math.floor(row.share * 100));
  let remainingPercent = 100 - wholePercent.reduce((sum, value) => sum + value, 0);
  [...categoryRows.keys()].sort((a, b) => (categoryRows[b].share * 100 % 1) - (categoryRows[a].share * 100 % 1)).forEach((index) => {
    if (remainingPercent > 0) { wholePercent[index] += 1; remainingPercent -= 1; }
  });
  categoryRows.forEach((row, index) => { row.percentage = total ? wholePercent[index] : 0; });
  const topMerchants = [...merchants.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const monthCount = Math.max(1, (new Date(`${endDate}T12:00:00`).getFullYear() - new Date(`${startDate}T12:00:00`).getFullYear()) * 12 + new Date(`${endDate}T12:00:00`).getMonth() - new Date(`${startDate}T12:00:00`).getMonth() + 1);
  const monthlyRows = [...new Set([...monthly.keys(), ...monthlyIncome.keys(), ...monthlyPreTaxRetirement.keys()])]
    .map((month) => ({ month, amount: monthly.get(month) || 0, income: monthlyIncome.get(month) || 0, pre_tax_retirement: monthlyPreTaxRetirement.get(month) || 0 }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const income = [...monthlyIncome.values()].reduce((sum, amount) => sum + amount, 0);
  const incomeSources = [...incomeSourceMap.values()].sort((a, b) => b.amount - a.amount);
  const preTaxRetirement = [...monthlyPreTaxRetirement.values()].reduce((sum, amount) => sum + amount, 0);
  const actualSpendCategories = [...actualSpendCategoryMap.values()].sort((a, b) => b.amount - a.amount);
  return { range, startDate, endDate, completedMonths, total, income, incomeSources, actualSpend, actualSpendCategories, savings, investments, savingsAndInvestments, preTaxRetirement, monthlyAverage: total / monthCount, categories: categoryRows, topMerchants, monthly: monthlyRows, transactions: transactionRows };
}

function monthId(dateString) {
  return String(dateString || '').slice(0, 7);
}

export function annualizedLivingSpend(store) {
  const eligible = store.transactions
    .filter((t) => !t.pending && !t.excluded && Number(t.amount || 0) > 0 && (t.bucket === 'fixed' || t.bucket === 'guilt_free'))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  if (!eligible.length) return { annualSpend: 0, monthlyAverage: 0, monthsObserved: 0 };

  const latest = new Date(`${monthId(eligible.at(-1).date)}-01T12:00:00`);
  const start = new Date(latest);
  start.setMonth(start.getMonth() - 11);
  const startMonth = start.toISOString().slice(0, 7);
  const latestMonth = latest.toISOString().slice(0, 7);

  const trailing = eligible.filter((t) => {
    const m = monthId(t.date);
    return m >= startMonth && m <= latestMonth;
  });
  const observedMonths = [...new Set(trailing.map((t) => monthId(t.date)))];
  const total = trailing.reduce((sum, t) => sum + Number(t.amount || 0), 0);
  const essentialTotal = trailing.filter((transaction) => transaction.bucket === 'fixed').reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  const monthsObserved = Math.max(observedMonths.length, 1);
  const monthlyAverage = total / monthsObserved;
  return { annualSpend: monthlyAverage * 12, monthlyAverage, essentialAnnualSpend: essentialTotal / monthsObserved * 12, essentialMonthlySpend: essentialTotal / monthsObserved, monthsObserved };
}

function annualizedContributions(store, buckets = ['savings', 'investments']) {
  const eligible = store.transactions
    .filter((t) => !t.pending && !t.excluded && Number(t.amount || 0) > 0 && buckets.includes(t.bucket))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!eligible.length) return { annualContributions: 0, monthsObserved: 0 };

  const latest = new Date(`${monthId(eligible.at(-1).date)}-01T12:00:00`);
  const start = new Date(latest);
  start.setMonth(start.getMonth() - 11);
  const startMonth = start.toISOString().slice(0, 7);
  const trailing = eligible.filter((transaction) => monthId(transaction.date) >= startMonth && monthId(transaction.date) <= monthId(latest.toISOString()));
  const monthsObserved = Math.max(new Set(trailing.map((transaction) => monthId(transaction.date))).size, 1);
  const total = trailing.reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
  return { annualContributions: total / monthsObserved * 12, monthsObserved };
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
  const age = Math.max(18, Number(settings.age || 27));
  const retirementAge = Math.max(age, Number(settings.retirement_age || 65));
  const withdrawalRate = Math.max(0.1, Number(settings.withdrawal_rate || 4)) / 100;
  const realReturn = Math.max(-0.9, Number(settings.real_return ?? 5)) / 100;
  const leanMultiplier = Math.max(1, Number(settings.lean_multiplier || 70)) / 100;
  const fatMultiplier = Math.max(1, Number(settings.fat_multiplier || 150)) / 100;
  const spend = annualizedLivingSpend(store);
  const contributions = annualizedContributions(store);
  const cashSavings = annualizedContributions(store, ['savings']);
  const investedAssets = (store.accounts || []).filter((account) => !account.hidden && account.type === 'investment').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);
  const freedomBalance = investedAssets || Math.max(0, Number(netWorth || 0));
  const cashBalance = (store.accounts || []).filter((account) => !account.hidden && account.type === 'depository').reduce((sum, account) => sum + Math.max(0, Number(account.current_balance || 0)), 0);

  const standard = spend.annualSpend > 0 ? spend.annualSpend / withdrawalRate : 0;
  const lean = standard * leanMultiplier;
  const fat = standard * fatMultiplier;
  const essential = spend.essentialAnnualSpend > 0 ? spend.essentialAnnualSpend / withdrawalRate : lean;
  const yearsToRetirement = Math.max(0, retirementAge - age);
  const coast = standard > 0 ? standard / Math.pow(1 + realReturn, yearsToRetirement) : 0;
  const futureValueFactor = realReturn === 0 ? yearsToRetirement : (Math.pow(1 + realReturn, yearsToRetirement) - 1) / realReturn;
  const projectedAtRetirement = freedomBalance * Math.pow(1 + realReturn, yearsToRetirement) + contributions.annualContributions * futureValueFactor;
  const progress = (target, balance = freedomBalance) => target > 0 ? Math.max(0, balance) / target * 100 : 0;
  const emergencyFund = spend.essentialMonthlySpend * 3;
  const runway = spend.essentialMonthlySpend * 6;

  return {
    age,
    retirementAge,
    // Decimal arithmetic can otherwise serialize a clean 7% as
    // 7.000000000000001%. These are user-facing assumptions, so preserve
    // sensible precision at the API boundary.
    withdrawalRate: Number((withdrawalRate * 100).toFixed(2)),
    realReturn: Number((realReturn * 100).toFixed(2)),
    leanMultiplier: leanMultiplier * 100,
    fatMultiplier: fatMultiplier * 100,
    annualSpend: spend.annualSpend,
    monthlySpend: spend.monthlyAverage,
    essentialAnnualSpend: spend.essentialAnnualSpend,
    essentialMonthlySpend: spend.essentialMonthlySpend,
    monthsObserved: spend.monthsObserved,
    annualContributions: contributions.annualContributions,
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
  store.snapshots = store.snapshots.filter((snapshot) => snapshot.source !== 'estimated');
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

export function seedDemo(store) {
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
    { id: 'demo-roth', item_id: 'demo-fidelity', plaid_account_id: 'demo-roth', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', current_balance: 26400, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-401k', item_id: 'demo-fidelity', plaid_account_id: 'demo-401k', institution_name: 'Fidelity', name: '401(k)', type: 'investment', subtype: '401k', current_balance: 43800, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-credit', item_id: 'demo-chase', plaid_account_id: 'demo-credit', institution_name: 'Chase', name: 'Chase Sapphire Preferred', type: 'credit', subtype: 'credit card', current_balance: 1160, interest_rate: 24.49, interest_rate_source: 'institution', mask: '4821', updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-venture', item_id: 'demo-capital-one', plaid_account_id: 'demo-venture', institution_name: 'Capital One', name: 'Capital One Venture', type: 'credit', subtype: 'credit card', current_balance: 640, interest_rate: 19.99, interest_rate_source: 'institution', mask: '6108', updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-auto', item_id: 'demo-capital-one', plaid_account_id: 'demo-auto', institution_name: 'Capital One', name: 'Auto loan', type: 'loan', subtype: 'auto', current_balance: 9350, interest_rate: 5.9, interest_rate_source: 'institution', updated_at: new Date().toISOString(), demo: true }
  ];
  store.positions = [
    ['demo-brokerage', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 92, 274, 25208],
    ['demo-brokerage', 'BND', 'Vanguard Total Bond Market ETF', 'etf', 62, 73, 4526],
    ['demo-roth', 'FSKAX', 'Fidelity Total Market Index Fund', 'mutual fund', 133, 151, 20083],
    ['demo-roth', 'SPAXX', 'Fidelity Government Money Market Fund', 'cash', 1791, 1, 1791],
    ['demo-401k', 'FXAIX', 'Fidelity 500 Index Fund', 'mutual fund', 183, 191, 34953],
    ['demo-401k', 'FSPSX', 'Fidelity International Index Fund', 'mutual fund', 123, 72, 8856]
  ].map(([account_id, ticker, name, type, quantity, price, value]) => ({ id: `demo-position-${ticker}-${account_id}`, item_id: 'demo-fidelity', account_id, ticker, name, type, quantity, price, value, cost_basis: Math.round(value * .9), demo: true }));
  ensureDemoMarketHistory(store);
  store.investment_snapshots = Array.from({ length: 84 }, (_, index) => { const date = new Date(now.getFullYear(), now.getMonth() - (83 - index), 1); return { date: date.toISOString().slice(0, 10), value: Math.round(21000 + index * 760 + Math.sin(index * .7) * 1800), source: 'verified' }; });
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

  const base = 84000;
  store.snapshots = Array.from({ length: 90 }, (_, i) => {
    const dt = new Date(now);
    dt.setDate(now.getDate() - (89 - i));
    const drift = i * 110 + Math.sin(i / 4.2) * 1100 + Math.sin(i / 12) * 650;
    const liabilities = Math.max(10450, 11500 - i * 11);
    return { date: dt.toISOString().slice(0, 10), assets: base + drift + liabilities, liabilities, net_worth: base + drift };
  });
  addDemoHistory(store);
  return store;
}

function ensureDemoMarketHistory(store) {
  store.market_prices ||= {};
  store.investment_position_snapshots ||= [];
  store.investment_transactions ||= [];
  const today = new Date();
  const byTicker = new Map();
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    byTicker.set(position.ticker, Number(position.price || (Number(position.value || 0) / Math.max(1, Number(position.quantity || 1)))));
  }
  for (const [ticker, currentPrice] of byTicker) {
    if (Object.keys(store.market_prices[ticker] || {}).length >= 300) continue;
    const prices = store.market_prices[ticker] ||= {};
    const phase = [...ticker].reduce((sum, character) => sum + character.charCodeAt(0), 0) / 13;
    for (let day = 365; day >= 0; day -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - day);
      const progress = (365 - day) / 365;
      // Demonstration-only market history: varied but restrained, so the
      // public preview teaches the chart interaction without implying a real
      // past return for a visitor.
      const multiplier = 0.88 + progress * 0.12 + Math.sin(progress * 17 + phase) * 0.018 + Math.sin(progress * 43 + phase) * 0.008;
      prices[date.toISOString().slice(0, 10)] = Math.round(currentPrice * multiplier * 100) / 100;
    }
  }
  // Demo-only acquisition records keep its personal-history chart internally
  // consistent with the same conservative rules used for real connections.
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    const id = `demo-trade-${position.account_id}-${position.ticker}`;
    if (store.investment_transactions.some((transaction) => transaction.id === id)) continue;
    const date = new Date(today);
    date.setFullYear(date.getFullYear() - 1);
    store.investment_transactions.push({ id, account_id: position.account_id, security_id: position.security_id || null, ticker: position.ticker, security_type: position.type, date: date.toISOString().slice(0, 10), quantity: Number(position.quantity || 0), price: Number(position.price || 0), amount: Number(position.value || 0), type: 'buy', subtype: 'buy', demo: true });
  }
  // The public preview is explicitly synthetic. Give it a consistent personal
  // chart without ever sharing this data with an authenticated person.
  for (const position of store.positions || []) {
    if (!position.ticker || position.type === 'cash') continue;
    for (const [date, price] of Object.entries(store.market_prices[position.ticker] || {})) {
      const key = position.id || `${position.account_id}:${position.ticker}`;
      if (store.investment_position_snapshots.some((record) => record.date === date && record.kind === 'holding' && record.key === key)) continue;
      store.investment_position_snapshots.push({ date, kind: 'holding', key, account_id: position.account_id, ticker: position.ticker, value: Math.round(Number(position.quantity || 0) * Number(price || 0) * 100) / 100, source: 'verified', demo: true });
    }
  }
}

function addDemoHistory(store) {
  const now = new Date();
  const existingTransactionIds = new Set(store.transactions.map((transaction) => transaction.id));
  const existingSnapshotDates = new Set(store.snapshots.map((snapshot) => snapshot.date));

  // Seven years of monthly records make the demo useful across every chart
  // range, while the detailed current month keeps the drill-down believable.
  const historyMonths = 84;
  const demoCurrentNetWorth = 95590;
  const demoStartingNetWorth = 26000;
  for (let monthsAgo = 1; monthsAgo <= historyMonths; monthsAgo += 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const month = date.toISOString().slice(0, 7);
    const variation = Math.round(Math.sin(monthsAgo * 1.7) * 110);
    const rows = [
      ['payroll', 'Payroll', -6200, 'income', 'demo-checking', 'INCOME'],
      ['interest', 'Ally Savings interest', -(38 + monthsAgo % 6), 'income', 'demo-hysa', 'INCOME'],
      ['rent', 'Rent', 1650, 'fixed', 'demo-credit', 'RENT_AND_UTILITIES'],
      ['essentials', 'Groceries & utilities', 690 + variation, 'fixed', 'demo-credit', 'FOOD_AND_DRINK'],
      ['saving', 'Ally Savings', 250, 'savings', 'demo-credit', 'TRANSFER_IN'],
      ['investing', 'Fidelity Brokerage', 350, 'investments', 'demo-credit', 'INVESTMENT'],
      ['flex', 'Dining & leisure', 520 - variation, 'guilt_free', 'demo-credit', 'ENTERTAINMENT']
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

    const snapshotDate = `${month}-28`;
    if (!existingSnapshotDates.has(snapshotDate)) {
      const progress = (historyMonths - monthsAgo) / historyMonths;
      const netWorth = Math.round(demoStartingNetWorth + (demoCurrentNetWorth - demoStartingNetWorth) * progress + Math.sin(progress * 16) * 1800);
      const liabilities = Math.round(16500 - progress * 7150);
      store.snapshots.push({
        date: snapshotDate,
        assets: netWorth + liabilities,
        liabilities,
        net_worth: netWorth
      });
    }
  }
  store.transactions.sort((a, b) => a.date.localeCompare(b.date));
  store.snapshots.sort((a, b) => a.date.localeCompare(b.date));
}
