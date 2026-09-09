import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateFire, cashRunway, classifyTransaction, clarityCheckin, connectionHealth, debtPayoffPlan, goalProgress, hideDuplicateAccounts, historicalSecurity, historicalTicker, investmentContributions, investmentDetailHistory, investmentLinkBalances, investmentRangeProgress, monthlyReview, reconstructInvestmentHistory, refreshReconstructedInvestmentSnapshots, investmentSummary, recurringCharges, removeEstimatedNetWorthHistory, repairTransferClassifications, seedDemo, snapshotInvestments, snapshotNetWorth, spendingSummary } from '../src/lib/finance.js';
import { normalizeCandles } from '../src/lib/market-data.js';
import { filterSnapshots, preferredNetWorthRange, scrubIndex, uniqueDailySnapshots } from '../public/chart-utils.js';

test('estimated history is removed before the chart is served', () => {
  const store = {
    snapshots: [
      { date: '2026-01-01', net_worth: 100, source: 'estimated' },
      { date: '2026-01-02', net_worth: 110, source: 'verified' }
    ]
  };
  assert.equal(removeEstimatedNetWorthHistory(store), true);
  assert.deepEqual(store.snapshots, [{ date: '2026-01-02', net_worth: 110, source: 'verified' }]);
});

test('a verified snapshot replaces an estimate for the same day', () => {
  const store = {
    accounts: [{ id: 'cash', type: 'depository', current_balance: 150 }],
    transactions: [],
    snapshots: [{ date: '2026-01-02', assets: 125, liabilities: 0, net_worth: 125, source: 'estimated' }]
  };
  snapshotNetWorth(store, '2026-01-02');
  assert.deepEqual(store.snapshots[0], { date: '2026-01-02', assets: 150, liabilities: 0, net_worth: 150, source: 'verified' });
});

test('one verified snapshot is retained per day and refreshes in place', () => {
  const store = { accounts: [{ id: 'cash', type: 'depository', current_balance: 100 }], transactions: [], snapshots: [] };
  snapshotNetWorth(store, '2026-01-02');
  store.accounts[0].current_balance = 125;
  snapshotNetWorth(store, '2026-01-02');
  snapshotNetWorth(store, '2026-01-03');
  assert.deepEqual(store.snapshots.map((snapshot) => [snapshot.date, snapshot.net_worth, snapshot.source]), [
    ['2026-01-02', 125, 'verified'],
    ['2026-01-03', 125, 'verified']
  ]);
});

test('timeframe filtering only returns snapshots within the selected range', () => {
  const snapshots = [
    { date: '2024-12-31' }, { date: '2025-01-01' }, { date: '2025-09-05' }
  ];
  const anchor = new Date('2025-09-05T12:00:00');
  assert.deepEqual(filterSnapshots(snapshots, 'ytd', anchor).map((snapshot) => snapshot.date), ['2025-01-01', '2025-09-05']);
  assert.deepEqual(filterSnapshots(snapshots, '1y', anchor).map((snapshot) => snapshot.date), ['2024-12-31', '2025-01-01', '2025-09-05']);
  assert.deepEqual(filterSnapshots([{ date: '2025-03-29' }, { date: '2025-03-30' }, { date: '2025-09-05' }], '6m', anchor).map((snapshot) => snapshot.date), ['2025-03-30', '2025-09-05']);
});

test('a new connection defaults net worth to its available verified history', () => {
  const anchor = new Date('2026-09-07T12:00:00');
  assert.equal(preferredNetWorthRange([{ date: '2026-09-05' }, { date: '2026-09-07' }], anchor), 'all');
  assert.equal(preferredNetWorthRange([{ date: '2026-08-01' }, { date: '2026-09-07' }], anchor), '1m');
  assert.equal(preferredNetWorthRange([{ date: '2026-01-01' }, { date: '2026-09-07' }], anchor), 'ytd');
});

test('chart input keeps only the latest value for each snapshot day', () => {
  assert.deepEqual(uniqueDailySnapshots([
    { date: '2026-09-05', net_worth: 100 }, { date: '2026-09-05', net_worth: 120 }, { date: '2026-09-06', net_worth: 121 }
  ]), [{ date: '2026-09-05', net_worth: 120 }, { date: '2026-09-06', net_worth: 121 }]);
});

test('scrubbing clamps to endpoints and selects the nearest data point', () => {
  const base = { left: 100, width: 300, pointCount: 5 };
  assert.equal(scrubIndex({ ...base, clientX: 50 }), 0);
  assert.equal(scrubIndex({ ...base, clientX: 250 }), 2);
  assert.equal(scrubIndex({ ...base, clientX: 500 }), 4);
});

test('historical pricing preserves provider symbols without guessing a retirement fund share class', () => {
  assert.equal(historicalTicker('VANGUARD.TARGET.2065', 'Vanguard Target 2065'), 'VANGUARD.TARGET.2065');
  assert.equal(historicalTicker('VTI', 'Vanguard Total Stock Market ETF'), 'VTI');
  assert.equal(historicalTicker(null, 'Vanguard Target 2065'), '');
  assert.deepEqual(historicalSecurity({ ticker: 'VANGUARD.TARGET.2065', name: 'Vanguard Target 2065', type: 'equity' }), { ticker: 'VANGUARD.TARGET.2065', type: 'equity' });
});

test('duplicate linked accounts with the same verified identity are hidden, not deleted', () => {
  const store = {
    accounts: [
      { id: 'older', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', mask: '1234', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'newer', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', mask: '1234', updated_at: '2026-01-02T00:00:00Z' },
      { id: 'different', institution_name: 'Fidelity', name: 'Roth IRA', type: 'investment', subtype: 'ira', mask: '9876', updated_at: '2026-01-02T00:00:00Z' }
    ]
  };
  assert.equal(hideDuplicateAccounts(store), 1);
  assert.equal(store.accounts.length, 3);
  assert.deepEqual(store.accounts.find((account) => account.id === 'older').hidden_reason, 'duplicate');
  assert.equal(store.accounts.find((account) => account.id === 'older').duplicate_of, 'newer');
  assert.equal(store.accounts.find((account) => account.id === 'different').hidden, undefined);
});

test('spending summary excludes transfers and groups only transactions in the selected timeframe', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: 80, bucket: 'guilt_free', pfc_primary: 'FOOD_AND_DRINK', merchant_name: 'Cafe' },
    { date: '2026-08-12', amount: 1200, bucket: 'fixed', pfc_primary: 'RENT_AND_UTILITIES', merchant_name: 'Rent' },
    { date: '2026-09-02', amount: 500, bucket: 'transfer', merchant_name: 'Card payment' },
    { date: '2025-08-20', amount: 30, bucket: 'guilt_free', pfc_primary: 'SHOPPING', merchant_name: 'Store' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.total, 80);
  assert.deepEqual(result.categories, [{ name: 'Guilt-free spending', amount: 80, share: 1, percentage: 100 }]);
  assert.deepEqual(result.topMerchants, [{ name: 'Cafe', amount: 80 }]);
});

test('monthly spending keeps income separate for comparison', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -4200, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-02', amount: 900, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-08-30', amount: -4000, bucket: 'income', merchant_name: 'Payroll' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.total, 900);
  assert.equal(result.income, 4200);
  assert.deepEqual(result.monthly, [{ month: '2026-09', amount: 900, income: 4200, pre_tax_retirement: 0 }]);
  assert.deepEqual(result.transactions.find((transaction) => transaction.category === 'Paychecks'), {
    id: undefined, name: 'Payroll', date: '2026-09-01', amount: 4200, category: 'Paychecks', bucket: 'income', flowKey: 'income_paychecks', flowLabel: 'Paychecks', flowGroup: 'income'
  });
  assert.deepEqual(result.incomeSources, [{ key: 'income_paychecks', label: 'Paychecks', amount: 4200 }]);
});

test('cash flow keeps HYSA interest distinct from paychecks without excluding either income source', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -4200, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-02', amount: -18.42, bucket: 'income', merchant_name: 'Ally interest payment', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_INTEREST_EARNED' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 4218.42);
  assert.deepEqual(result.incomeSources, [
    { key: 'income_paychecks', label: 'Paychecks', amount: 4200 },
    { key: 'income_interest', label: 'Interest', amount: 18.42 }
  ]);
});

test('multi-month cash flow excludes an incomplete current month', () => {
  const store = { transactions: [
    { date: '2026-06-15', amount: -1000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-07-15', amount: -1000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-08-15', amount: -1000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-02', amount: 900, bucket: 'fixed', merchant_name: 'Early rent' }
  ] };
  const result = spendingSummary(store, '3m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.startDate, '2026-06-01');
  assert.equal(result.endDate, '2026-08-31');
  assert.equal(result.completedMonths, true);
  assert.equal(result.income, 3000);
  assert.equal(result.total, 0);
  const sixMonth = spendingSummary(store, '6m', new Date('2026-09-05T12:00:00'));
  assert.equal(sixMonth.startDate, '2026-03-01');
  assert.equal(sixMonth.endDate, '2026-08-31');
  const monthToDate = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(monthToDate.completedMonths, false);
  assert.equal(monthToDate.total, 900);
});

test('cash flow separates actual spending details from saving and investing', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -5000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-02', amount: 1800, bucket: 'fixed', pfc_primary: 'RENT_AND_UTILITIES', pfc_detailed: 'RENT_AND_UTILITIES_RENT', merchant_name: 'Rent' },
    { date: '2026-09-03', amount: 240, bucket: 'fixed', pfc_primary: 'FOOD_AND_DRINK', pfc_detailed: 'FOOD_AND_DRINK_GROCERIES', merchant_name: 'Grocer' },
    { date: '2026-09-03', amount: 90, bucket: 'guilt_free', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', merchant_name: 'Shop' },
    { date: '2026-09-04', amount: 500, bucket: 'investments', merchant_name: 'Brokerage transfer' },
    { date: '2026-09-05', amount: 250, bucket: 'savings', merchant_name: 'Savings transfer' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.actualSpend, 2130);
  assert.equal(result.savings, 250);
  assert.equal(result.investments, 500);
  assert.equal(result.savingsAndInvestments, 750);
  assert.deepEqual(result.actualSpendCategories.map((row) => [row.key, row.amount]), [['housing_bills', 1800], ['food_dining', 240], ['shopping', 90]]);
});

test('investment contribution activity includes bank deposits and payroll retirement contributions', () => {
  const store = { transactions: [
    { date: '2026-08-01', account_id: 'brokerage', amount: 500, bucket: 'investments' },
    { date: '2026-08-15', account_id: '401k', amount: 400, bucket: 'investments', source: 'investment_transaction' },
    { date: '2026-08-18', account_id: 'checking', amount: 125, bucket: 'transfer', investment_contribution_amount: 125, investment_contribution_account_id: 'hsa' },
    { date: '2026-08-20', amount: 100, bucket: 'savings' },
    { date: '2026-08-25', amount: 300, bucket: 'investments', excluded: true }
  ] };
  assert.deepEqual(investmentContributions(store), [{ date: '2026-08-01', accountId: 'brokerage', amount: 500 }, { date: '2026-08-15', accountId: '401k', amount: 400 }, { date: '2026-08-18', accountId: 'hsa', amount: 125 }]);
});

test('newly linked investment balances are kept separate from contributions', () => {
  assert.deepEqual(investmentLinkBalances({ investment_link_events: [{ account_id: 'hsa', date: '2026-09-06', amount: 2089, historical_coverage: false }] }), [{ accountId: 'hsa', date: '2026-09-06', amount: 2089, historicalCoverage: false }]);
  assert.deepEqual(investmentLinkBalances({ investment_link_events: [{ account_id: 'fund', date: '2026-09-06', amount: 500, historical_coverage: true }] }), [{ accountId: 'fund', date: '2026-09-06', amount: 500, historicalCoverage: true }]);
});

test('recurring charge awareness identifies cadence and a meaningful increase', () => {
  const store = { transactions: [
    { date: '2026-06-03', amount: 15, bucket: 'guilt_free', merchant_name: 'Stream Plus' },
    { date: '2026-07-03', amount: 15, bucket: 'guilt_free', merchant_name: 'Stream Plus' },
    { date: '2026-08-03', amount: 20, bucket: 'guilt_free', merchant_name: 'Stream Plus' },
    { date: '2026-06-08', amount: 35, bucket: 'guilt_free', merchant_name: 'Scheduled meal kit', pfc_primary: 'FOOD_AND_DRINK' },
    { date: '2026-07-09', amount: 35, bucket: 'guilt_free', merchant_name: 'Scheduled meal kit', pfc_primary: 'FOOD_AND_DRINK' },
    { date: '2026-08-10', amount: 35, bucket: 'guilt_free', merchant_name: 'Scheduled meal kit', pfc_primary: 'FOOD_AND_DRINK' },
    { date: '2026-06-15', amount: 1400, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-07-15', amount: 1400, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-08-15', amount: 1400, bucket: 'fixed', merchant_name: 'Rent' }
  ] };
  const recurring = recurringCharges(store, new Date('2026-09-05T12:00:00'));
  assert.deepEqual(recurring.recurring.map((charge) => [charge.name, charge.cadence]), [['Rent', 'monthly'], ['Scheduled meal kit', 'monthly'], ['Stream Plus', 'monthly']]);
  assert.equal(recurring.increases[0].name, 'Stream Plus');
  assert.ok(Math.abs(recurring.increases[0].change - (20 / 15 - 1)) < 1e-9);
  assert.ok(recurring.recurring.some((charge) => charge.name === 'Scheduled meal kit'));
});

test('portfolio history keeps one verified investment value for each day', () => {
  const store = { accounts: [{ type: 'investment', current_balance: 1000 }], investment_snapshots: [] };
  snapshotInvestments(store, '2026-09-01');
  store.accounts[0].current_balance = 1250;
  snapshotInvestments(store, '2026-09-01');
  snapshotInvestments(store, '2026-09-02');
  assert.deepEqual(store.investment_snapshots, [
    { date: '2026-09-01', value: 1250, source: 'verified' },
    { date: '2026-09-02', value: 1250, source: 'verified' }
  ]);
});

test('verified holding snapshots retain provider identity and observed quantity and price', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', type: 'investment', current_balance: 1_250, iso_currency_code: 'USD' }],
    positions: [{ id: 'ira:vti', account_id: 'ira', security_id: 'security-vti', ticker: 'VTI', provider_ticker: 'VTI', type: 'etf', quantity: 10, price: 125, value: 1_250, price_as_of: '2026-09-07', iso_currency_code: 'USD' }],
    investment_snapshots: [], investment_position_snapshots: []
  };
  snapshotInvestments(store, '2026-09-07');
  assert.deepEqual(store.investment_position_snapshots, [
    { date: '2026-09-07', kind: 'account', key: 'ira', account_id: 'ira', account_type: 'investment', iso_currency_code: 'USD', value: 1_250, source: 'verified' },
    { date: '2026-09-07', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'security-vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 125, price_as_of: '2026-09-07', security_type: 'etf', iso_currency_code: 'USD', unofficial_currency_code: null, value: 1_250, source: 'verified' }
  ]);
});

test('verified holding snapshots preserve unavailable provider facts as null', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', type: 'investment', current_balance: 500 }],
    positions: [{ id: 'ira:unknown', account_id: 'ira', security_id: 'unknown', ticker: 'FUND', type: 'mutual fund', quantity: null, price: null, value: 500 }],
    investment_snapshots: [], investment_position_snapshots: []
  };
  snapshotInvestments(store, '2026-09-07');
  const holding = store.investment_position_snapshots.find((row) => row.kind === 'holding');
  assert.equal(holding.quantity, null);
  assert.equal(holding.price, null);
});

test('selected holding range calls a change market performance only with unchanged verified shares', () => {
  const store = {
    investment_position_snapshots: [
      { date: '2026-08-10', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 100, value: 1_000, source: 'verified' },
      { date: '2026-09-07', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 110, value: 1_100, source: 'verified' }
    ]
  };
  const result = investmentRangeProgress(store, { ticker: 'VTI', range: '1m' });
  assert.deepEqual(result, {
    scope: 'holding', range: '1m', state: 'ready', points: 2,
    startDate: '2026-08-10', endDate: '2026-09-07', startValue: 1_000, endValue: 1_100, valueChange: 100,
    marketChange: 100, marketChangePct: .1, changeKind: 'market'
  });
});

test('selected investment ranges never call deposits or account changes market performance', () => {
  const store = {
    investment_position_snapshots: [
      { date: '2026-08-10', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 100, value: 1_000, source: 'verified' },
      // A purchase added five shares. The balance change is true; the return is unknown.
      { date: '2026-09-07', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 15, price: 110, value: 1_650, source: 'verified' },
      { date: '2026-08-10', kind: 'account', key: 'ira', account_id: 'ira', value: 1_000, source: 'verified' },
      { date: '2026-09-07', kind: 'account', key: 'ira', account_id: 'ira', value: 1_650, source: 'verified' }
    ]
  };
  const holding = investmentRangeProgress(store, { ticker: 'VTI' });
  assert.equal(holding.valueChange, 650);
  assert.equal(holding.marketChange, null);
  assert.equal(holding.changeKind, 'balance');
  const account = investmentRangeProgress(store, { accountId: 'ira' });
  assert.equal(account.valueChange, 650);
  assert.equal(account.marketChange, null);
  assert.equal(account.changeKind, 'balance');
});

test('one verified account snapshot begins personal investment tracking without inventing earlier values', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', item_id: 'item-1', type: 'investment', name: 'IRA', current_balance: 1_250, hidden: false }],
    positions: [{ id: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', value: 1_250 }],
    investment_transactions: [], market_prices: {}, items: [{ id: 'item-1' }], investment_position_snapshots: []
  };
  snapshotInvestments(store, '2026-09-07');
  const detail = investmentDetailHistory(store, { accountId: 'ira' });
  assert.equal(detail.state, 'tracking');
  assert.deepEqual(detail.history, [{ date: '2026-09-07', value: 1_250 }]);
  assert.match(detail.detail, /verified institution update/i);
});

test('an unavailable account detail preserves its nickname and reported balance', () => {
  const store = {
    accounts: [{ plaid_account_id: 'hsa', type: 'investment', name: 'Institution HSA', nickname: 'Udemy HSA', current_balance: 2_089, hidden: false }],
    positions: [], investment_transactions: [], investment_position_snapshots: [], items: []
  };
  const detail = investmentDetailHistory(store, { accountId: 'hsa' });
  assert.equal(detail.state, 'unavailable');
  assert.equal(detail.label, 'Udemy HSA');
  assert.equal(detail.value, 2_089);
});

test('investment reconstruction starts at a fully reported opening trade and uses historical closes', () => {
  const store = {
    positions: [{ security_id: 'fund', ticker: 'VFINX', type: 'mutual fund', quantity: 10, value: 1100 }],
    investment_transactions: [{ security_id: 'fund', ticker: 'VFINX', security_type: 'mutual fund', date: '2026-09-03', quantity: 10 }],
    market_prices: { VFINX: { '2025-09-01': 90, '2026-09-01': 100, '2026-09-05': 110 } }
  };
  const history = reconstructInvestmentHistory(store, '2026-09-05');
  assert.equal(history.find((snapshot) => snapshot.date === '2026-09-03').value, 1000);
  assert.equal(history.at(-1).value, 1100);
  assert.equal(history[0].date, '2026-09-03');
  assert.equal(history.at(-1).date, '2026-09-05');
  assert.ok(history.every((snapshot) => snapshot.source === 'reconstructed'));
});

test('a fully reported $1 investment-cash ledger can be reconstructed without inventing a deposit balance', () => {
  const store = {
    accounts: [{ plaid_account_id: 'brokerage', type: 'investment', current_balance: 100 }],
    positions: [{ account_id: 'brokerage', security_id: 'cash', ticker: 'CASH', type: 'cash', quantity: 100, price: 1, value: 100 }],
    investment_transactions: [{ account_id: 'brokerage', security_id: 'cash', ticker: 'CASH', security_type: 'cash', date: '2026-01-15', quantity: 100 }],
    market_prices: {}, investment_position_snapshots: []
  };
  const result = investmentDetailHistory(store, { accountId: 'brokerage', years: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.reconstructed, true);
  assert.equal(result.history[0].date, '2026-01-15');
  assert.equal(result.history.at(-1).value, 100);
});

test('investment reconstruction withholds an unknown opening balance inside the requested period', () => {
  const history = reconstructInvestmentHistory({
    positions: [{ security_id: 'fund', ticker: 'VFINX', type: 'mutual fund', quantity: 10, value: 1100 }],
    // The two reported shares do not prove when the remaining eight arrived.
    investment_transactions: [{ security_id: 'fund', ticker: 'VFINX', security_type: 'mutual fund', date: '2026-09-03', quantity: 2 }],
    market_prices: { VFINX: { '2026-09-01': 100, '2026-09-05': 110 } }
  }, '2026-09-05');
  assert.deepEqual(history, []);
});

test('investment reconstruction refuses a sold security with no current provider position', () => {
  const history = reconstructInvestmentHistory({
    positions: [],
    investment_transactions: [{ security_id: 'sold-fund', ticker: 'VANGUARD.TARGET.2065', security_name: 'Vanguard Target 2065', security_type: 'equity', date: '2026-09-01', quantity: -10 }],
    market_prices: { VLXVX: { '2026-04-01': 100, '2026-09-06': 110 } }
  }, '2026-09-06', 1);
  assert.deepEqual(history, []);
});

test('market candle parsing retains usable closes by session date', () => {
  const prices = normalizeCandles({ s: 'ok', t: [1704168000], c: [301.53] });
  assert.equal(Object.values(prices)[0], 301.53);
  assert.equal(normalizeCandles({ s: 'no_data' }).constructor, Object);
});

test('investment summary separates portfolio total, allocation, and positions', () => {
  const store = {
    accounts: [{ id: 'ira', plaid_account_id: 'plaid-ira', name: 'Roth IRA', institution_name: 'Fidelity', type: 'investment', current_balance: 10000 }],
    positions: [
      { account_id: 'plaid-ira', name: 'US Equity Fund', ticker: 'VTI', type: 'etf', value: 7000, cost_basis: 6300, quantity: 20, asset_class_override: 'Equities' },
      { account_id: 'plaid-ira', name: 'Money market', ticker: 'SPAXX', type: 'cash', value: 2500, quantity: 2500 }
    ]
  };
  const result = investmentSummary(store);
  assert.equal(result.total, 10000);
  assert.equal(result.positionsAvailable, true);
  assert.equal(result.positions[0].gain, 700);
  assert.equal(result.positions[0].gain_pct, 700 / 6300);
  assert.deepEqual(result.allocation.map((row) => [row.name, row.value]), [['Equities', 7000], ['Cash', 2500], ['Cash & unclassified', 500]]);
  assert.deepEqual(result.unclassifiedAccounts, [{ account_id: 'plaid-ira', name: 'Roth IRA', institution_name: 'Fidelity', balance: 10000, holdings_value: 9500, difference: 500 }]);
});

test('holding detail history uses only provider-observed snapshots', () => {
  const store = {
    accounts: [{ plaid_account_id: 'brokerage', type: 'investment', name: 'Brokerage', hidden: false }],
    positions: [{ account_id: 'brokerage', security_id: 'vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', quantity: 10, value: 1100, cost_basis: 900 }],
    investment_position_snapshots: [
      { date: '2026-01-15', kind: 'holding', key: 'vti', account_id: 'brokerage', ticker: 'VTI', value: 1000, source: 'verified' },
      { date: '2026-09-01', kind: 'holding', key: 'vti', account_id: 'brokerage', ticker: 'VTI', value: 1100, source: 'verified' }
    ]
  };
  const result = investmentDetailHistory(store, { ticker: 'VTI', years: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.value, 1100);
  assert.equal(result.gain, 200);
  assert.deepEqual(result.market, []);
  assert.deepEqual(result.history, [{ date: '2026-01-15', value: 1000 }, { date: '2026-09-01', value: 1100 }]);
});

test('reported trades and prices create history only after it reconciles to the current institution value', () => {
  const store = {
    accounts: [{ plaid_account_id: '401k', type: 'investment', name: 'Work 401(k)', hidden: false }],
    positions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', name: 'Fund', type: 'etf', quantity: 5, value: 550 }],
    investment_transactions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', date: '2026-01-15', quantity: 5 }],
    market_prices: { VTI: { '2025-12-31': 95, '2026-01-15': 100, '2026-09-01': 110 } }
  };
  const result = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.reconstructed, true);
  assert.equal(result.history.at(-1).value, 550);
  assert.match(result.detail, /matches your latest institution value/i);
});

test('a later holding does not erase earlier reported account history or create a pre-opening balance', () => {
  const store = {
    accounts: [{ plaid_account_id: '401k', type: 'investment', name: 'Work 401(k)', hidden: false }],
    positions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', name: 'US fund', type: 'etf', quantity: 5, value: 550 },
      { account_id: '401k', security_id: 'intl', ticker: 'VXUS', name: 'International fund', type: 'etf', quantity: 4, value: 200 }
    ],
    investment_transactions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', date: '2026-01-15', quantity: 5 },
      { account_id: '401k', security_id: 'intl', ticker: 'VXUS', date: '2026-03-15', quantity: 4 }
    ],
    market_prices: {
      VTI: { '2026-01-15': 100, '2026-03-15': 105, '2026-09-01': 110 },
      VXUS: { '2026-03-15': 45, '2026-09-01': 50 }
    }
  };
  const result = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.history[0].date, '2026-01-15');
  assert.equal(result.history.find((row) => row.date === '2026-02-15').value, 500);
  assert.equal(result.history.at(-1).value, 750);
});

test('account reconstruction includes a security sold during the selected history window', () => {
  const store = {
    accounts: [{ plaid_account_id: '401k', type: 'investment', name: 'Work 401(k)', current_balance: 550, hidden: false }],
    positions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', name: 'US fund', type: 'etf', quantity: 5, value: 550 }
    ],
    investment_transactions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', security_type: 'etf', date: '2026-01-15', quantity: 5 },
      { account_id: '401k', security_id: 'intl', ticker: 'VXUS', security_type: 'etf', date: '2026-01-15', quantity: 10 },
      { account_id: '401k', security_id: 'intl', ticker: 'VXUS', security_type: 'etf', date: '2026-03-15', quantity: -10 }
    ],
    market_prices: {
      VTI: { '2026-01-15': 100, '2026-03-15': 105, '2026-09-01': 110 },
      VXUS: { '2026-01-15': 45, '2026-03-15': 50, '2026-09-01': 55 }
    }
  };

  const detail = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(detail.state, 'ready');
  assert.equal(detail.history[0].date, '2026-01-15');
  assert.equal(detail.history.find((row) => row.date === '2026-02-15').value, 950);
  assert.equal(detail.history.find((row) => row.date === '2026-04-15').value, 525);
  assert.equal(detail.history.at(-1).value, 550);

  const portfolio = refreshReconstructedInvestmentSnapshots(store, '2026-09-01', 1);
  assert.equal(portfolio.find((row) => row.date === '2026-02-15').value, 950);
  assert.equal(portfolio.at(-1).value, 550);
});

test('account and portfolio history are withheld when a sold security cannot be identified and priced', () => {
  const store = {
    accounts: [{ plaid_account_id: '401k', type: 'investment', name: 'Work 401(k)', current_balance: 550, hidden: false }],
    positions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', name: 'US fund', type: 'etf', quantity: 5, value: 550 }
    ],
    investment_transactions: [
      { account_id: '401k', security_id: 'us', ticker: 'VTI', security_type: 'etf', date: '2026-01-15', quantity: 5 },
      { account_id: '401k', security_id: null, ticker: null, security_type: 'etf', date: '2026-03-15', quantity: -10 }
    ],
    market_prices: { VTI: { '2026-01-15': 100, '2026-09-01': 110 } },
    investment_snapshots: []
  };

  const detail = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(detail.state, 'unavailable');
  assert.equal(detail.label, 'Work 401(k)');
  assert.equal(detail.value, 550);
  assert.match(detail.reason, /enough priced security detail/i);
  assert.deepEqual(detail.history, []);

  assert.deepEqual(refreshReconstructedInvestmentSnapshots(store, '2026-09-01', 1), []);
  assert.deepEqual(store.investment_snapshots, []);
});

test('a reconstruction with a material current-value mismatch is withheld', () => {
  const store = {
    accounts: [{ plaid_account_id: 'brokerage', type: 'investment', name: 'Brokerage', hidden: false }],
    positions: [{ account_id: 'brokerage', security_id: 'fund', ticker: 'VTI', name: 'Fund', type: 'etf', quantity: 5, value: 900 }],
    investment_transactions: [{ account_id: 'brokerage', security_id: 'fund', ticker: 'VTI', date: '2026-01-15', quantity: 5 }],
    market_prices: { VTI: { '2026-01-15': 100, '2026-09-01': 110 } }
  };
  const result = investmentDetailHistory(store, { accountId: 'brokerage', years: 1 });
  assert.equal(result.state, 'unavailable');
  assert.match(result.reason, /does not closely match/i);
});

test('portfolio history is reconstructed only when every visible investment account reconciles', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', type: 'investment', current_balance: 1100, hidden: false }],
    positions: [{ account_id: 'ira', security_id: 'fund', ticker: 'VFINX', type: 'mutual fund', quantity: 10, value: 1100 }],
    investment_transactions: [{ account_id: 'ira', security_id: 'fund', ticker: 'VFINX', date: '2026-09-03', quantity: 10 }],
    market_prices: { VFINX: { '2025-09-01': 90, '2026-09-01': 100, '2026-09-05': 110 } },
    investment_snapshots: []
  };
  const history = refreshReconstructedInvestmentSnapshots(store, '2026-09-05', 1);
  assert.equal(history.at(-1).value, 1100);
  assert.ok(store.investment_snapshots.every((snapshot) => snapshot.source === 'reconstructed'));
});

test('a holding without reported trades does not receive an inferred personal trend', () => {
  const store = {
    accounts: [{ plaid_account_id: 'linked', type: 'investment', name: 'Linked account', hidden: false }],
    positions: [{ account_id: 'linked', security_id: 'fund', ticker: 'VTI', name: 'Fund', type: 'etf', quantity: 2, value: 220 }],
    investment_transactions: [],
    investment_link_events: [{ account_id: 'linked', date: '2026-09-01', amount: 220 }],
    market_prices: { VTI: { '2025-09-01': 80, '2026-09-01': 110 } }
  };
  const result = investmentDetailHistory(store, { accountId: 'linked', years: 1 });
  assert.deepEqual(result.history, []);
  assert.equal(result.state, 'unavailable');
});

test('a pending provider extraction never creates a personal investment history before reported trades arrive', () => {
  const store = {
    items: [{ id: 'item-401k', investment_history_state: 'preparing' }],
    accounts: [{ item_id: 'item-401k', plaid_account_id: '401k', type: 'investment', name: 'New job 401(k)', hidden: false }],
    positions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', name: 'Fund', type: 'etf', quantity: 8, value: 960 }],
    investment_transactions: [],
    market_prices: { VTI: { '2025-09-01': 100, '2026-01-01': 105, '2026-09-01': 120 } }
  };
  const result = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(result.state, 'preparing');
  assert.deepEqual(result.history, []);
  assert.match(result.reason, /still preparing/i);
});

test('refreshing derived portfolio history removes an old overextended reconstruction', () => {
  const store = {
    positions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', type: 'etf', quantity: 5 }],
    investment_transactions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', date: '2026-01-15', quantity: 5 }],
    market_prices: { VTI: { '2025-12-31': 95, '2026-01-15': 100, '2026-09-01': 110 } },
    investment_snapshots: [{ date: '2025-12-31', value: 475, source: 'reconstructed' }, { date: '2026-09-01', value: 550, source: 'verified' }]
  };
  refreshReconstructedInvestmentSnapshots(store, '2026-09-01', 1);
  assert.equal(store.investment_snapshots.some((snapshot) => snapshot.date === '2025-12-31'), false);
  assert.equal(store.investment_snapshots.find((snapshot) => snapshot.source === 'verified')?.value, 550);
});

test('manual holdings fill only an institution-reported position gap', () => {
  const store = {
    accounts: [
      { plaid_account_id: 'missing', name: 'Brokerage', institution_name: 'Example Broker', type: 'investment', current_balance: 3000 },
      { plaid_account_id: 'reported', name: 'IRA', institution_name: 'Example Broker', type: 'investment', current_balance: 1000 }
    ],
    positions: [{ id: 'reported-position', account_id: 'reported', name: 'Cash', ticker: 'CASH', type: 'cash', value: 1000 }],
    manual_holdings: [{ id: 'manual-position', account_id: 'missing', name: 'Broad market fund', ticker: 'FUND', asset_class: 'Funds', value: 3000 }]
  };
  const result = investmentSummary(store);
  assert.equal(result.total, 4000);
  assert.deepEqual(result.unclassifiedAccounts, []);
  assert.deepEqual(result.allocation.map((row) => [row.name, row.value]), [['Funds', 3000], ['Cash', 1000]]);
  assert.equal(result.positions.find((position) => position.id === 'manual-position').manual, true);
  assert.equal(result.positions.find((position) => position.id === 'manual-position').gain, null);
});

test('demo mode provides seven years of usable account and spending history', () => {
  const store = { accounts: [], transactions: [], snapshots: [], settings: { demo_mode: true } };
  seedDemo(store);
  assert.ok(store.snapshots.length >= 84);
  assert.ok(new Set(store.transactions.map((transaction) => transaction.date.slice(0, 7))).size >= 84);
  assert.ok(store.accounts.some((account) => account.type === 'loan'));
  const snapshots = store.investment_snapshots;
  const portfolioChange = snapshots.at(-1).value - snapshots[0].value;
  const contributions = investmentContributions(store).reduce((sum, row) => sum + row.amount, 0);
  assert.ok(portfolioChange - contributions > 0, 'demo all-time investment growth should be positive');
  assert.deepEqual(goalProgress(store).map((goal) => goal.name), ['Emergency fund']);
  const recurringNames = recurringCharges(store).recurring.map((charge) => charge.name);
  assert.ok(recurringNames.includes('Netflix'));
  assert.equal(recurringNames.some((name) => /groceries|dining|leisure/i.test(name)), false);
});

test('demo spending remains categorized across its historical ranges', () => {
  const store = { accounts: [], transactions: [], snapshots: [], items: [], positions: [], investment_snapshots: [] };
  seedDemo(store);
  const summary = spendingSummary(store, '1y');
  assert.ok(summary.actualSpendCategories.length >= 3);
  assert.equal(summary.actualSpendCategories.some((category) => category.key === 'uncategorized'), false);
  assert.equal(summary.transactions.some((transaction) => transaction.flowKey === 'uncategorized'), false);
  assert.ok(summary.incomeSources.some((source) => source.key === 'income_paychecks'));
  assert.ok(summary.incomeSources.some((source) => source.key === 'income_interest'));
});

test('pre-tax retirement contributions remain visible without distorting take-home cash flow', () => {
  const store = { transactions: [
    { id: 'bank', date: '2026-09-01', amount: 7000, bucket: 'investments', name: 'Fidelity transfer' },
    { id: 'ira', date: '2026-09-02', amount: 7000, bucket: 'investments', name: 'IRA contribution', source: 'investment_transaction' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.total, 7000);
  assert.equal(result.actualSpend, 0);
  assert.equal(result.savingsAndInvestments, 7000);
  assert.equal(result.preTaxRetirement, 7000);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions.find((transaction) => transaction.name === 'Fidelity transfer').flowGroup, 'investments');
  assert.deepEqual(result.transactions.find((transaction) => transaction.flowKey === 'payroll_retirement'), {
    id: 'ira', name: 'IRA contribution', date: '2026-09-02', amount: 7000,
    category: 'Payroll retirement', bucket: 'pre_tax_retirement', flowKey: 'payroll_retirement', flowLabel: 'Payroll retirement', flowGroup: 'payroll_retirement'
  });
});

test('fixed costs stay limited to essential obligations', () => {
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 75, personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 400, personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 500, name: 'Payment Thank You', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), 'transfer');
});

test('card payments and generic withdrawals cannot be inferred as investing from a shared institution name', () => {
  const cardPayment = { amount: 875, name: 'Fidelity credit card payment', pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', bucket: 'investments', investment_contribution_amount: 875 };
  const withdrawal = { amount: 600, name: 'Fidelity withdrawal', pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_WITHDRAWAL', bucket: 'investments', investment_contribution_amount: 600 };
  const explicitInvestment = { amount: 400, pfc_primary: 'TRANSFER_OUT', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS', bucket: 'investments' };
  const memberChoice = { amount: 300, pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', bucket: 'investments', category_overridden: true };
  assert.equal(classifyTransaction({ amount: cardPayment.amount, name: cardPayment.name, personal_finance_category: { primary: cardPayment.pfc_primary, detailed: cardPayment.pfc_detailed } }), 'transfer');
  assert.equal(repairTransferClassifications({ transactions: [cardPayment, withdrawal, explicitInvestment, memberChoice] }), 2);
  assert.equal(cardPayment.bucket, 'transfer');
  assert.equal(withdrawal.bucket, 'transfer');
  assert.equal(explicitInvestment.bucket, 'investments');
  assert.equal(memberChoice.bucket, 'investments');
  assert.equal('investment_contribution_amount' in cardPayment, false);
});

test('cash runway uses cash and savings against recent complete-month fixed costs', () => {
  const store = {
    accounts: [
      { type: 'depository', current_balance: 9000 },
      { type: 'investment', current_balance: 50000 },
      { type: 'credit', current_balance: 800 }
    ],
    transactions: [
      { date: '2026-06-03', amount: 2000, bucket: 'fixed' },
      { date: '2026-07-03', amount: 2500, bucket: 'fixed' },
      { date: '2026-08-03', amount: 2500, bucket: 'fixed' },
      { date: '2026-08-04', amount: 300, bucket: 'guilt_free' }
    ]
  };
  const runway = cashRunway(store, new Date('2026-09-05T12:00:00'));
  assert.equal(runway.cash, 9000);
  assert.equal(runway.monthsObserved, 3);
  assert.equal(runway.essentialMonthly, 7000 / 3);
  assert.equal(runway.runwayMonths, 9000 / (7000 / 3));
});

test('goals use tracked balances and debt payoff measures progress downward', () => {
  const store = { accounts: [
    { type: 'depository', current_balance: 4000 }, { type: 'investment', current_balance: 9000 }, { type: 'loan', current_balance: 6000 }
  ], settings: { goals: [{ id: 'cash', name: 'Reserve', source: 'cash', target: 10000 }, { id: 'debt', name: 'Loan payoff', source: 'debt', target: 12000 }] } };
  const [cash, debt] = goalProgress(store);
  assert.equal(cash.current, 4000); assert.equal(cash.progress, .4);
  assert.equal(debt.current, 6000); assert.equal(debt.progress, .5);
});

test('debt payoff plan recommends the highest known rate or the smallest balance by choice', () => {
  const store = { accounts: [
    { id: 'card', name: 'Card', type: 'credit', current_balance: 1200, interest_rate: 25.99 },
    { id: 'auto', name: 'Auto', type: 'loan', current_balance: 9000, interest_rate: 5.9 },
    { id: 'medical', name: 'Medical', type: 'loan', current_balance: 450 }
  ], settings: {} };
  const avalanche = debtPayoffPlan(store);
  assert.equal(avalanche.totalDebt, 10650);
  assert.equal(avalanche.accountCount, 3);
  assert.equal(avalanche.strategy, 'avalanche');
  assert.equal(avalanche.priority.id, 'card');
  assert.equal(avalanche.missingRates, 1);
  store.settings.debt_strategy = 'snowball';
  const snowball = debtPayoffPlan(store);
  assert.equal(snowball.priority.id, 'medical');
});

test('avalanche does not pretend to know a target without an interest rate', () => {
  const plan = debtPayoffPlan({ accounts: [{ id: 'loan', name: 'Loan', type: 'loan', current_balance: 1000 }], settings: {} });
  assert.equal(plan.priority, null);
  assert.equal(plan.missingRates, 1);
});

test('monthly review surfaces only a large, repeatable category deviation', () => {
  const transactions = [];
  for (const month of ['2026-04', '2026-05', '2026-06']) transactions.push({ date: `${month}-10`, amount: 100, bucket: 'guilt_free', pfc_primary: 'TRAVEL' });
  transactions.push({ date: '2026-07-10', amount: 400, bucket: 'guilt_free', pfc_primary: 'TRAVEL' });
  const review = monthlyReview({ transactions }, new Date('2026-08-15T12:00:00'));
  assert.equal(review.available, true); assert.equal(review.outlier.category, 'Travel'); assert.equal(review.outlier.difference, 300);
  const quiet = monthlyReview({ transactions: transactions.map((transaction) => transaction.date === '2026-07-10' ? { ...transaction, amount: 150 } : transaction) }, new Date('2026-08-15T12:00:00'));
  assert.equal(quiet.outlier, null);
});

test('clarity check-in uses a freedom step when calm and prioritizes a material outlier', () => {
  const transactions = [];
  for (const month of ['2026-04', '2026-05', '2026-06']) {
    transactions.push({ date: `${month}-01`, amount: -3000, bucket: 'income' });
    transactions.push({ date: `${month}-10`, amount: 100, bucket: 'guilt_free', pfc_primary: 'TRAVEL' });
  }
  transactions.push({ date: '2026-07-01', amount: -3000, bucket: 'income' });
  transactions.push({ date: '2026-07-10', amount: 100, bucket: 'guilt_free', pfc_primary: 'TRAVEL' });
  const steady = clarityCheckin({ transactions, accounts: [], items: [] }, new Date('2026-08-15T12:00:00'));
  assert.equal(steady.tone, 'steady');
  assert.match(steady.title, /Next: Coast independence/);
  transactions.push({ date: '2026-07-20', amount: 400, bucket: 'guilt_free', pfc_primary: 'TRAVEL' });
  const outlier = clarityCheckin({ transactions, accounts: [], items: [] }, new Date('2026-08-15T12:00:00'));
  assert.equal(outlier.tone, 'watch');
  assert.match(outlier.title, /Travel/);
});

test('clarity check-in uses one next freedom step when cash flow has no material issue', () => {
  const store = {
    accounts: [
      { type: 'depository', current_balance: 4500 },
      { type: 'investment', current_balance: 20000 }
    ],
    items: [],
    transactions: [
      { date: '2026-07-01', amount: 1000, bucket: 'fixed' },
      { date: '2026-07-15', amount: 250, bucket: 'guilt_free' },
      { date: '2026-08-01', amount: 1000, bucket: 'fixed' },
      { date: '2026-08-15', amount: 250, bucket: 'guilt_free' }
    ]
  };
  const checkin = clarityCheckin(store, new Date('2026-09-06T12:00:00Z'));
  assert.equal(checkin.action, 'retirement');
  assert.match(checkin.title, /Next: Six-month buffer/);
  assert.match(checkin.detail, /6 months of essentials/);
});

test('connection health stays quiet through transient delays and failures', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const health = connectionHealth({ items: [
    { id: 'fresh', institution_name: 'Fresh', last_synced_at: '2026-09-05T10:00:00Z' },
    { id: 'briefly-late', institution_name: 'Briefly late', last_synced_at: '2026-09-04T10:00:00Z' },
    { id: 'late', institution_name: 'Late', last_synced_at: '2026-09-01T10:00:00Z' },
    { id: 'failed-once', institution_name: 'Failed once', last_synced_at: '2026-09-06T10:00:00Z', last_sync_error_at: '2026-09-06T11:00:00Z' },
    { id: 'failed', institution_name: 'Failed', last_synced_at: '2026-09-02T10:00:00Z', last_sync_error_at: '2026-09-06T11:00:00Z', sync_failure_count: 3 },
    { id: 'reauth', institution_name: 'Reauth', last_synced_at: '2026-09-06T10:00:00Z', requires_reconnect: true },
    { id: 'legacy', institution_name: 'Legacy' }
  ], accounts: [
    { item_id: 'legacy', updated_at: '2026-09-06T11:30:00Z' }
  ] }, now);
  assert.deepEqual(health.map((item) => item.state), ['healthy', 'healthy', 'stale', 'healthy', 'attention', 'attention', 'healthy']);
  assert.equal(health[5].requires_reconnect, true);
  assert.equal(health[6].last_synced_at, '2026-09-06T11:30:00.000Z');
});

test('retirement presets calculate coast, lean, standard, fat, and a projected retirement value', () => {
  const store = {
    settings: { fire: { age: 35, retirement_age: 65, withdrawal_rate: 4, real_return: 5, lean_multiplier: 70, fat_multiplier: 150 } },
    transactions: [
      { date: '2026-09-01', amount: 3000, bucket: 'fixed' },
      { date: '2026-09-02', amount: 1000, bucket: 'guilt_free' },
      { date: '2026-09-03', amount: 500, bucket: 'investments' },
      { date: '2026-09-04', amount: 250, bucket: 'savings' }
    ]
  };
  const plan = calculateFire(store, 100000);
  assert.equal(plan.annualSpend, 48000);
  assert.equal(plan.withdrawalRate, 4);
  assert.equal(plan.realReturn, 5);
  assert.equal(plan.standard, 1200000);
  assert.equal(plan.lean, 840000);
  assert.equal(plan.fat, 1800000);
  assert.equal(plan.essentialAnnualSpend, 36000);
  assert.equal(plan.lifestyles[0].target, 900000);
  assert.equal(plan.ladder[0].target, 9000);
  assert.equal(plan.ladder[1].target, 18000);
  assert.equal(plan.ladder[0].estimatedMonths, 36);
  assert.equal(plan.ladder[2].estimatedMonths, null, 'a Coast FI date is not shown when this saving pace cannot catch the moving target before retirement');
  assert.ok(plan.coast < plan.standard);
  assert.ok(plan.projectedAtRetirement > 100000);
  assert.equal(plan.progress.standard, 100000 / 1200000 * 100);

  const laterRetirement = calculateFire({ ...store, settings: { fire: { ...store.settings.fire, retirement_age: 70 } } }, 100000);
  assert.ok(laterRetirement.coast < plan.coast, 'more time for growth lowers the Coast FI balance needed today');
  assert.ok(laterRetirement.projectedAtRetirement > plan.projectedAtRetirement, 'more time raises the projected portfolio value');
  assert.equal(laterRetirement.standard, plan.standard, 'the balance needed to support the same lifestyle does not depend on retirement age');
  assert.deepEqual(laterRetirement.lifestyles.map((path) => path.target), plan.lifestyles.map((path) => path.target));

  const lowerWithdrawalRate = calculateFire({ ...store, settings: { fire: { ...store.settings.fire, withdrawal_rate: 3.5 } } }, 100000);
  assert.ok(lowerWithdrawalRate.standard > plan.standard, 'a more conservative withdrawal rate raises the lifestyle target');

  const fasterSaver = calculateFire({
    ...store,
    transactions: store.transactions.map((transaction) => transaction.bucket === 'investments' ? { ...transaction, amount: 1000 } : transaction)
  }, 100000);
  const coastMonths = fasterSaver.ladder.find((step) => step.key === 'coast').estimatedMonths;
  assert.ok(coastMonths > 0 && coastMonths <= fasterSaver.yearsToRetirement * 12, 'Coast FI is estimated only within the retirement horizon');
  let projected = 100000;
  for (let month = 0; month < coastMonths; month += 1) projected = projected * (1 + 0.05 / 12) + fasterSaver.annualContributions / 12;
  const movingTarget = fasterSaver.standard / Math.pow(1.05, (fasterSaver.yearsToRetirement * 12 - coastMonths) / 12);
  assert.ok(projected >= movingTarget, 'the estimated date crosses the Coast target at that future date, not today’s frozen target');
});

test('each signed-in identity has an isolated persistent store', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-user-store-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  const store = await import(`../src/lib/store.js?isolation=${Date.now()}`);
  const ownerKey = store.userStorageKey('owner@example.com');
  const partnerKey = store.userStorageKey('partner@example.com');
  store.writeStore({ accounts: [{ id: 'owner-account' }], items: [], transactions: [], snapshots: [], settings: {} }, ownerKey);
  assert.equal(store.readStore(ownerKey).accounts[0].id, 'owner-account');
  const rawStore = fs.readFileSync(path.join(tempDir, 'users', `${ownerKey}.json`), 'utf8');
  assert.doesNotMatch(rawStore, /owner-account/);
  assert.match(rawStore, /"payload_enc"/);
  assert.equal(store.readStore(ownerKey).settings.appearance.theme, 'light');
  assert.equal(store.readStore(partnerKey).accounts.length, 0);
  assert.notEqual(ownerKey, partnerKey);
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
});
