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
  const positions = (store.positions || []).filter((position) => !position.hidden && accountIds.has(position.account_id));
  const total = accounts.reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  const holdingsValue = positions.reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
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
    positions: positions.map((position) => ({ ...position, gain: position.cost_basis == null ? null : Number(position.value || 0) - Number(position.cost_basis), gain_pct: position.cost_basis ? (Number(position.value || 0) - Number(position.cost_basis)) / Number(position.cost_basis) : null })).sort((a, b) => Number(b.value || 0) - Number(a.value || 0)),
    snapshots: (store.investment_snapshots || []).slice(-3650),
    positionsAvailable: positions.length > 0
  };
}

export function snapshotInvestments(store, snapshotDate = new Date().toISOString().slice(0, 10)) {
  const value = store.accounts.filter((account) => !account.hidden && account.type === 'investment').reduce((sum, account) => sum + Math.abs(Number(account.current_balance || 0)), 0);
  store.investment_snapshots ||= [];
  const existing = store.investment_snapshots.find((snapshot) => snapshot.date === snapshotDate);
  const snapshot = { date: snapshotDate, value, source: 'verified' };
  if (existing) Object.assign(existing, snapshot); else store.investment_snapshots.push(snapshot);
  store.investment_snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (store.investment_snapshots.length > 3650) store.investment_snapshots = store.investment_snapshots.slice(-3650);
}

function nearestPrice(prices, date) {
  return Object.keys(prices || {}).filter((day) => day <= date).sort().at(-1) ? Number(prices[Object.keys(prices).filter((day) => day <= date).sort().at(-1)]) : null;
}

export function reconstructInvestmentHistory(store, endDate = new Date().toISOString().slice(0, 10), years = 1) {
  const transactions = (store.investment_transactions || []).filter((transaction) => transaction.date <= endDate);
  const current = new Map();
  for (const position of store.positions || []) {
    const entry = current.get(position.security_id) || { quantity: 0, ticker: position.ticker, type: position.type };
    entry.quantity += Number(position.quantity || 0);
    entry.ticker ||= position.ticker;
    entry.type ||= position.type;
    current.set(position.security_id, entry);
  }
  for (const transaction of transactions) {
    if (!transaction.security_id) continue;
    const entry = current.get(transaction.security_id) || { quantity: 0, ticker: transaction.ticker, type: transaction.security_type };
    entry.ticker ||= transaction.ticker;
    entry.type ||= transaction.security_type;
    current.set(transaction.security_id, entry);
  }
  if (!current.size) return [];
  const start = new Date(`${endDate}T12:00:00`);
  start.setFullYear(start.getFullYear() - years);
  start.setDate(1);
  const dates = [];
  for (const date = new Date(start); date <= new Date(`${endDate}T12:00:00`); date.setMonth(date.getMonth() + 1)) dates.push(new Date(date).toISOString().slice(0, 10));
  if (dates.at(-1) !== endDate) dates.push(endDate);
  const snapshots = [];
  for (const date of dates) {
    let value = 0;
    let complete = true;
    for (const [securityId, holding] of current) {
      const quantity = holding.quantity - transactions.filter((transaction) => transaction.security_id === securityId && transaction.date > date).reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0);
      if (!quantity) continue;
      const price = holding.type === 'cash' ? 1 : nearestPrice(store.market_prices?.[holding.ticker], date);
      if (!Number.isFinite(price)) { complete = false; break; }
      value += quantity * price;
    }
    if (complete && Number.isFinite(value) && value >= 0) snapshots.push({ date, value: Math.round(value * 100) / 100, source: 'reconstructed' });
  }
  return snapshots;
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
  if (transaction.bucket === 'savings') return { key: 'savings', label: 'Savings', group: 'save_invest' };
  if (transaction.bucket === 'investments') return { key: 'investments', label: 'Investments', group: 'save_invest' };
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

export function spendingSummary(store, range = '1m', anchor = new Date()) {
  const { startDate, endDate, completedMonths } = spendingPeriod(range, anchor);
  const categories = new Map();
  const merchants = new Map();
  const monthly = new Map();
  const monthlyIncome = new Map();
  const monthlyPreTaxRetirement = new Map();
  const transactionRows = [];
  const actualSpendCategoryMap = new Map();
  let actualSpend = 0;
  let savingsAndInvestments = 0;
  const incomeTransactions = store.transactions.filter((transaction) => {
    if (transaction.pending || transaction.excluded || transaction.bucket !== 'income') return false;
    return transaction.date >= startDate && transaction.date <= endDate;
  });
  for (const transaction of incomeTransactions) {
    const month = String(transaction.date).slice(0, 7);
    monthlyIncome.set(month, (monthlyIncome.get(month) || 0) + Math.abs(Number(transaction.amount || 0)));
    transactionRows.push({
      id: transaction.id || transaction.plaid_transaction_id,
      name: transaction.merchant_name || transaction.name || 'Income',
      date: transaction.date,
      amount: Math.abs(Number(transaction.amount || 0)),
      category: 'Income',
      bucket: 'income',
      flowKey: 'income',
      flowLabel: 'Net income',
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
    if (transaction.bucket === 'savings' || transaction.bucket === 'investments') savingsAndInvestments += amount;
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
  const preTaxRetirement = [...monthlyPreTaxRetirement.values()].reduce((sum, amount) => sum + amount, 0);
  const actualSpendCategories = [...actualSpendCategoryMap.values()].sort((a, b) => b.amount - a.amount);
  return { range, startDate, endDate, completedMonths, total, income, actualSpend, actualSpendCategories, savingsAndInvestments, preTaxRetirement, monthlyAverage: total / monthCount, categories: categoryRows, topMerchants, monthly: monthlyRows, transactions: transactionRows };
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
  const monthsObserved = Math.max(observedMonths.length, 1);
  const monthlyAverage = total / monthsObserved;
  return { annualSpend: monthlyAverage * 12, monthlyAverage, monthsObserved };
}

function annualizedContributions(store) {
  const eligible = store.transactions
    .filter((t) => !t.pending && !t.excluded && Number(t.amount || 0) > 0 && (t.bucket === 'savings' || t.bucket === 'investments'))
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

  const standard = spend.annualSpend > 0 ? spend.annualSpend / withdrawalRate : 0;
  const lean = standard * leanMultiplier;
  const fat = standard * fatMultiplier;
  const yearsToRetirement = Math.max(0, retirementAge - age);
  const coast = standard > 0 ? standard / Math.pow(1 + realReturn, yearsToRetirement) : 0;
  const futureValueFactor = realReturn === 0 ? yearsToRetirement : (Math.pow(1 + realReturn, yearsToRetirement) - 1) / realReturn;
  const projectedAtRetirement = Number(netWorth || 0) * Math.pow(1 + realReturn, yearsToRetirement) + contributions.annualContributions * futureValueFactor;
  const progress = (target) => target > 0 ? Math.max(0, Number(netWorth || 0)) / target * 100 : 0;

  return {
    age,
    retirementAge,
    withdrawalRate: withdrawalRate * 100,
    realReturn: realReturn * 100,
    leanMultiplier: leanMultiplier * 100,
    fatMultiplier: fatMultiplier * 100,
    annualSpend: spend.annualSpend,
    monthlySpend: spend.monthlyAverage,
    monthsObserved: spend.monthsObserved,
    annualContributions: contributions.annualContributions,
    contributionMonthsObserved: contributions.monthsObserved,
    yearsToRetirement,
    projectedAtRetirement,
    standard,
    lean,
    coast,
    fat,
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

export function seedDemo(store) {
  if (store.accounts.length || store.transactions.length || store.snapshots.length) {
    if (store.accounts.length && store.accounts.every((account) => account.demo)) addDemoHistory(store);
    return store;
  }
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const d = (day) => `${month}-${String(day).padStart(2, '0')}`;
  store.accounts = [
    { id: 'demo-checking', item_id: 'demo-bank', plaid_account_id: 'demo-checking', institution_name: 'Chase', name: 'Checking', type: 'depository', subtype: 'checking', current_balance: 5200, available_balance: 5000, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-hysa', item_id: 'demo-bank', plaid_account_id: 'demo-hysa', institution_name: 'Ally', name: 'High Yield Savings', type: 'depository', subtype: 'savings', current_balance: 12500, available_balance: 12500, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-brokerage', item_id: 'demo-fidelity', plaid_account_id: 'demo-brokerage', institution_name: 'Fidelity', name: 'Brokerage', type: 'investment', subtype: 'brokerage', current_balance: 18200, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-roth', item_id: 'demo-fidelity', plaid_account_id: 'demo-roth', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', current_balance: 26400, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-401k', item_id: 'demo-fidelity', plaid_account_id: 'demo-401k', institution_name: 'Fidelity', name: '401(k)', type: 'investment', subtype: '401k', current_balance: 43800, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-credit', item_id: 'demo-bank', plaid_account_id: 'demo-credit', institution_name: 'Chase', name: 'Credit Card', type: 'credit', subtype: 'credit card', current_balance: 1160, updated_at: new Date().toISOString(), demo: true },
    { id: 'demo-auto', item_id: 'demo-bank', plaid_account_id: 'demo-auto', institution_name: 'Capital One', name: 'Auto loan', type: 'loan', subtype: 'auto', current_balance: 9350, updated_at: new Date().toISOString(), demo: true }
  ];
  store.positions = [
    ['demo-brokerage', 'VTI', 'Vanguard Total Stock Market ETF', 'etf', 92, 274, 25208],
    ['demo-brokerage', 'BND', 'Vanguard Total Bond Market ETF', 'etf', 62, 73, 4526],
    ['demo-roth', 'FSKAX', 'Fidelity Total Market Index Fund', 'mutual fund', 133, 151, 20083],
    ['demo-roth', 'SPAXX', 'Fidelity Government Money Market Fund', 'cash', 1791, 1, 1791],
    ['demo-401k', 'FXAIX', 'Fidelity 500 Index Fund', 'mutual fund', 183, 191, 34953],
    ['demo-401k', 'FSPSX', 'Fidelity International Index Fund', 'mutual fund', 123, 72, 8856]
  ].map(([account_id, ticker, name, type, quantity, price, value]) => ({ id: `demo-position-${ticker}-${account_id}`, item_id: 'demo-fidelity', account_id, ticker, name, type, quantity, price, value, cost_basis: Math.round(value * .9), demo: true }));
  store.investment_snapshots = Array.from({ length: 84 }, (_, index) => { const date = new Date(now.getFullYear(), now.getMonth() - (83 - index), 1); return { date: date.toISOString().slice(0, 10), value: Math.round(21000 + index * 760 + Math.sin(index * .7) * 1800), source: 'verified' }; });
  const rows = [
    ['payroll-1', 'Payroll', -3100, d(1), 'income'],
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
    id, plaid_transaction_id: id, account_id: amount < 0 ? 'demo-checking' : 'demo-credit',
    merchant_name: merchant, name: merchant, amount, date, bucket, excluded: false, pending: false,
    pfc_primary: demoPfc(merchant), pfc_detailed: '', demo: true
  }));
  store.transactions.push({
    id: 'demo-401k-contribution', plaid_transaction_id: 'demo-401k-contribution', account_id: 'demo-401k',
    merchant_name: '401(k) employee contribution', name: '401(k) employee contribution', amount: 750, date: d(15),
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
      ['payroll', 'Payroll', -6200, 'income', 'demo-checking'],
      ['rent', 'Rent', 1650, 'fixed', 'demo-credit'],
      ['essentials', 'Groceries & utilities', 690 + variation, 'fixed', 'demo-credit'],
      ['saving', 'Ally Savings', 250, 'savings', 'demo-credit'],
      ['investing', 'Fidelity Brokerage', 350, 'investments', 'demo-credit'],
      ['flex', 'Dining & leisure', 520 - variation, 'guilt_free', 'demo-credit']
    ];
    for (const [kind, merchant, amount, bucket, accountId] of rows) {
      const id = `demo-history-${month}-${kind}`;
      if (existingTransactionIds.has(id)) continue;
      store.transactions.push({
        id, plaid_transaction_id: id, account_id: accountId, merchant_name: merchant, name: merchant,
        amount, date: `${month}-15`, bucket, excluded: false, pending: false,
        pfc_primary: '', pfc_detailed: '', demo: true
      });
    }
    const contributionId = `demo-history-${month}-401k`;
    if (!existingTransactionIds.has(contributionId)) {
      store.transactions.push({
        id: contributionId, plaid_transaction_id: contributionId, account_id: 'demo-401k',
        merchant_name: '401(k) employee contribution', name: '401(k) employee contribution', amount: 750,
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
