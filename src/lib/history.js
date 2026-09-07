// Reconstructed balances are estimates, never institution-reported history.
// Keep the calculation independent of network/storage so missing evidence and
// every cash/quantity movement can be exercised with deterministic fixtures.
const DAY = 86_400_000;
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`);
const validDate = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
  && Number.isFinite(dayNumber(date)) && new Date(dayNumber(date)).toISOString().slice(0, 10) === date;
const number = (value) => value != null && value !== '' && Number.isFinite(Number(value));
const dollars = (value) => Math.round(value * 100) / 100;
const unavailable = (reason) => ({ state: 'unavailable', reason, history: [] });
const usd = (record) => record?.iso_currency_code === 'USD' && !record.unofficial_currency_code;

export function historyStart(end, years = 1) {
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - Math.max(1, Math.min(2, Number(years) || 1)));
  return date.toISOString().slice(0, 10);
}

export function priceAt(prices, date) {
  // Four closed market days (long holiday weekends) fit within this bound.
  // A longer outage must shorten coverage, not draw a fictitious flat line.
  for (let offset = 0; offset <= 7; offset += 1) {
    const key = new Date(dayNumber(date) - offset * DAY).toISOString().slice(0, 10);
    if (number(prices?.[key]) && Number(prices[key]) > 0) return Number(prices[key]);
  }
  return null;
}

export function mergeReportedHistory(reconstructed, observed) {
  const reported = [...observed].sort((a, b) => a.date.localeCompare(b.date));
  const first = reported[0]?.date;
  // Once observed tracking begins, retain its actual dates, including gaps.
  return [...reconstructed.filter((row) => !first || row.date < first), ...reported];
}

function reconciles(history, observed, tolerance) {
  const values = new Map(history.map((row) => [row.date, row.value]));
  return observed.every((row) => !values.has(row.date)
    || Math.abs(values.get(row.date) - row.value) <= tolerance(row.value));
}

function result(history, observed, tolerance) {
  if (history.length < 2) return unavailable('There is not enough complete activity and price history yet.');
  if (!reconciles(history, observed, tolerance)) return unavailable('Earlier recorded balances do not agree with the available activity.');
  return { state: 'ready', history, startDate: history[0].date };
}

export function reconstructCashAccount(store, account, { years = 2, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!['depository', 'credit'].includes(account.type)) return unavailable('This account needs reported historical balances.');
  const item = (store.items || []).find((row) => row.id === account.item_id);
  const anchor = account.transaction_balance_anchor;
  if (item?.transactions_history_complete !== true || !anchor || !validDate(anchor.date)
    || anchor.date > today || dayNumber(today) - dayNumber(anchor.date) > 7 * DAY
    || !usd(anchor) || !number(anchor.balance)) return unavailable('Waiting for complete account activity and a current balance.');
  const transactions = (store.transactions || []).filter((row) => row.account_id === account.plaid_account_id && !row.pending && row.source !== 'investment_transaction');
  // Categories and "exclude from spending" never change a balance ledger.
  if (!transactions.length || transactions.some((row) => !validDate(row.date) || !number(row.amount) || !usd(row) || row.date > anchor.date)) {
    return unavailable('Some account activity is missing the details needed for history.');
  }
  const start = [historyStart(anchor.date, years), ...transactions.map((row) => row.date).sort().slice(0, 1)].sort().at(-1);
  const daily = new Map();
  for (const row of transactions) daily.set(row.date, (daily.get(row.date) || 0) + Number(row.amount));
  let balance = Number(anchor.balance);
  const history = [];
  for (let time = dayNumber(anchor.date); time >= dayNumber(start); time -= DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    // Overdrafts/credit balances require different accounting in the current
    // net-worth summary. Do not quietly apply its absolute-value convention.
    if (balance < -0.01) break;
    history.push({ date, value: dollars(Math.max(0, balance)), source: 'reconstructed' });
    balance += (account.type === 'credit' ? -1 : 1) * (daily.get(date) || 0);
  }
  history.reverse();
  const observed = (store.account_balance_snapshots || []).filter((row) => row.account_id === account.plaid_account_id && row.source === 'verified');
  return result(history, observed, (value) => Math.max(1, Math.abs(value) * .001));
}

export function reconstructInvestmentAccount(store, account, { years = 1, ticker = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const item = (store.items || []).find((row) => row.id === account.item_id);
  const ledger = item?.investment_ledger;
  const anchor = account.investment_balance_anchor;
  if (!ledger?.complete || !validDate(ledger.start_date) || !ledger.holdings_sync_id || !anchor || ledger.holdings_sync_id !== anchor.sync_id
    || ledger.end_date !== anchor.date || !validDate(anchor.date) || anchor.date > today
    || dayNumber(today) - dayNumber(anchor.date) > 7 * DAY || !usd(anchor) || !number(anchor.balance) || anchor.balance < 0) {
    return unavailable('Waiting for complete investment activity and matching holdings.');
  }
  const current = (store.positions || []).filter((row) => row.account_id === account.plaid_account_id && !row.hidden);
  if (!current.length || current.some((row) => !usd(row) || !number(row.quantity) || row.quantity < 0 || !number(row.value) || row.value < 0)) {
    return unavailable('Your institution has not provided all the holding details needed for history.');
  }
  const accountTransactions = (store.investment_transactions || []).filter((row) => row.account_id === account.plaid_account_id);
  if (accountTransactions.some((row) => !validDate(row.date))) return unavailable('Some investment activity is missing a usable date.');
  const transactions = accountTransactions.filter((row) => row.date >= ledger.start_date && row.date <= anchor.date);
  if (!transactions.length || transactions.some((row) => !validDate(row.date) || !usd(row) || !number(row.amount) || !number(row.quantity))) {
    return unavailable('Some investment activity is missing the details needed for history.');
  }
  const supported = (row) => ['equity', 'etf', 'mutual fund'].includes(row.type)
    && /^[A-Z][A-Z0-9.-]{0,14}$/.test(row.ticker || '') && row.security_id && row.provider_ticker === row.ticker;
  const cashPositions = current.filter((row) => row.type === 'cash');
  if (cashPositions.some((row) => !number(row.price) || Math.abs(Number(row.price) - 1) > .0001 || Math.abs(Number(row.quantity) - Number(row.value)) > .01)) {
    return unavailable('This cash holding needs historical prices from your institution.');
  }
  const securities = new Map(current.filter((row) => row.type !== 'cash').map((row) => [row.security_id, { ...row, quantity: Number(row.quantity) }]));
  if ([...securities.values()].some((row) => !supported(row))) return unavailable('A holding does not have an exact supported market symbol.');
  const holdingsValue = current.reduce((sum, row) => sum + Number(row.value), 0);
  if (Math.abs(holdingsValue - Number(anchor.balance)) > Math.max(1, Number(anchor.balance) * .0001)) {
    return unavailable('Some of this account’s balance is not represented by reported holdings.');
  }
  let cash = cashPositions.reduce((sum, row) => sum + Number(row.value), 0);
  let start = [historyStart(anchor.date, years), ledger.start_date, transactions.map((row) => row.date).sort()[0]].sort().at(-1);
  const daily = new Map();
  for (const row of transactions) {
    const subtype = String(row.subtype || '').toLowerCase();
    const quantity = Number(row.quantity);
    const cashSecurity = cashPositions.some((position) => position.security_id === row.security_id);
    const reinvestment = ['dividend reinvestment', 'interest reinvestment', 'long-term capital gain reinvestment', 'short-term capital gain reinvestment'].includes(subtype);
    const fundedReinvestment = reinvestment && quantity > 0 && (Number(row.amount) === 0 || (row.security_id && transactions.some((income) =>
      income.date === row.date && income.security_id === row.security_id && Number(income.quantity) === 0
      && income.type === 'cash' && Number(income.amount) < 0 && Math.abs(Number(income.amount) + Number(row.amount)) < .01)));
    // Plaid documents positive amounts for simultaneous contributions and
    // purchases. An explicit contribution with incoming shares can therefore
    // add those shares without fabricating a separate cash deposit/debit.
    const combinedContribution = row.type === 'cash' && subtype === 'contribution' && quantity > 0 && Number(row.amount) > 0;
    // Ambiguous transfers, combined plan contributions, shorts and corporate
    // actions form a boundary. History after them can still be useful.
    const trade = ['buy', 'sell'].includes(row.type) && ['buy', 'sell'].includes(subtype)
      && (row.type === 'buy' ? quantity > 0 && row.amount >= 0 : quantity < 0 && row.amount <= 0);
    const cashOnly = quantity === 0 && (row.type === 'fee' || (['cash', 'transfer'].includes(row.type)
      && ['deposit', 'withdrawal', 'contribution', 'distribution', 'dividend', 'qualified dividend', 'non-qualified dividend', 'interest', 'account fee', 'management fee', 'tax', 'tax withheld', 'transfer fee', 'long-term capital gain', 'short-term capital gain'].includes(subtype)));
    if ((!trade && !cashOnly && !fundedReinvestment && !combinedContribution) || cashSecurity) {
      start = [start, row.date].sort().at(-1);
      continue;
    }
    if (quantity !== 0 && !securities.has(row.security_id)) {
      const security = { security_id: row.security_id, ticker: row.ticker, provider_ticker: row.provider_ticker, type: row.security_type, quantity: 0 };
      if (!supported(security)) { start = [start, row.date].sort().at(-1); continue; }
      securities.set(row.security_id, security);
    }
    if (!daily.has(row.date)) daily.set(row.date, []);
    daily.get(row.date).push({ ...row, cashAmount: combinedContribution ? 0 : Number(row.amount) });
  }
  const history = [];
  for (let time = dayNumber(anchor.date); time >= dayNumber(start); time -= DAY) {
    const date = new Date(time).toISOString().slice(0, 10);
    let value = ticker ? 0 : cash;
    let usable = cash >= -.01;
    for (const position of securities.values()) {
      if (position.quantity < -.000001) { usable = false; break; }
      if (position.quantity <= .000001) continue;
      // Legacy caches may contain split/dividend-adjusted prices. They cannot
      // be multiplied by contemporaneous share quantities.
      const metadata = store.market_price_metadata?.[position.ticker];
      const price = metadata?.basis === 'unadjusted' ? priceAt(store.market_prices?.[position.ticker], date) : null;
      if (price == null) { usable = false; break; }
      if (!ticker || position.ticker === ticker) value += position.quantity * price;
    }
    if (!usable) break;
    history.push({ date, value: dollars(value), source: 'reconstructed' });
    for (const row of daily.get(date) || []) {
      if (Number(row.quantity) !== 0) securities.get(row.security_id).quantity -= Number(row.quantity);
      cash += row.cashAmount;
    }
  }
  history.reverse();
  const target = ticker ? current.filter((row) => row.ticker === ticker).reduce((sum, row) => sum + Number(row.value), 0) : Number(anchor.balance);
  if (!history.length || Math.abs(history.at(-1).value - target) > Math.max(1, Math.abs(target) * .01)) {
    return unavailable('Historical prices do not agree with the latest reported value.');
  }
  const observed = (store.investment_position_snapshots || []).filter((row) => row.source === 'verified' && row.account_id === account.plaid_account_id
    && (ticker ? row.kind === 'holding' && row.ticker === ticker : row.kind === 'account'));
  return result(history, observed, (value) => Math.max(1, Math.abs(value) * .01));
}

export function combinedHistory(histories) {
  if (!histories.length || histories.some((rows) => rows.length < 2)) return [];
  const maps = histories.map((rows) => new Map(rows.map((row) => [row.date, row.value])));
  return histories[0].filter((row) => maps.every((map) => map.has(row.date))).map((row) => ({
    date: row.date, value: dollars(maps.reduce((sum, map) => sum + map.get(row.date), 0)), source: 'reconstructed'
  }));
}

export function reconstructedNetWorth(store, options = {}) {
  const accounts = (store.accounts || []).filter((row) => !row.hidden);
  const histories = accounts.map((account) => account.type === 'investment'
    ? reconstructInvestmentAccount(store, account, options) : reconstructCashAccount(store, account, options));
  if (!histories.length || histories.some((entry) => entry.state !== 'ready')) return [];
  const dates = combinedHistory(histories.map((entry) => entry.history));
  const maps = histories.map((entry) => new Map(entry.history.map((row) => [row.date, row.value])));
  return dates.map(({ date }) => {
    let assets = 0, liabilities = 0;
    accounts.forEach((account, index) => {
      if (account.type === 'credit') liabilities += maps[index].get(date);
      else assets += maps[index].get(date);
    });
    return { date, assets: dollars(assets), liabilities: dollars(liabilities), net_worth: dollars(assets - liabilities), source: 'reconstructed' };
  }).filter((row) => !(store.snapshots || []).some((observed) => observed.source === 'verified' && observed.date <= row.date));
}
