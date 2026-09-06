import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { calculateFire, cashRunway, classifyTransaction, hideDuplicateAccounts, reconstructInvestmentHistory, investmentSummary, removeEstimatedNetWorthHistory, seedDemo, snapshotInvestments, snapshotNetWorth, spendingSummary } from '../finance.js';
import { normalizeCandles } from '../market-data.js';
import { filterSnapshots, scrubIndex } from '../public/chart-utils.js';

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
});

test('scrubbing clamps to endpoints and selects the nearest data point', () => {
  const base = { left: 100, width: 300, pointCount: 5 };
  assert.equal(scrubIndex({ ...base, clientX: 50 }), 0);
  assert.equal(scrubIndex({ ...base, clientX: 250 }), 2);
  assert.equal(scrubIndex({ ...base, clientX: 500 }), 4);
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
  assert.deepEqual(result.transactions.find((transaction) => transaction.category === 'Income'), {
    id: undefined, name: 'Payroll', date: '2026-09-01', amount: 4200, category: 'Income', bucket: 'income'
  });
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

test('investment reconstruction reverses later purchases and uses historical closes', () => {
  const store = {
    positions: [{ security_id: 'fund', ticker: 'VFINX', type: 'mutual fund', quantity: 10 }],
    investment_transactions: [{ security_id: 'fund', ticker: 'VFINX', security_type: 'mutual fund', date: '2026-09-03', quantity: 2 }],
    market_prices: { VFINX: { '2026-09-01': 100, '2026-09-05': 110 } }
  };
  const history = reconstructInvestmentHistory(store, '2026-09-05');
  assert.equal(history.find((snapshot) => snapshot.date === '2026-09-01').value, 800);
  assert.equal(history.at(-1).value, 1100);
  assert.ok(history.every((snapshot) => snapshot.source === 'reconstructed'));
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
});

test('demo mode provides seven years of usable account and spending history', () => {
  const store = { accounts: [], transactions: [], snapshots: [] };
  seedDemo(store);
  assert.ok(store.snapshots.length >= 84);
  assert.ok(new Set(store.transactions.map((transaction) => transaction.date.slice(0, 7))).size >= 84);
  assert.ok(store.accounts.some((account) => account.type === 'loan'));
});

test('pre-tax retirement contributions remain visible without distorting take-home cash flow', () => {
  const store = { transactions: [
    { id: 'bank', date: '2026-09-01', amount: 7000, bucket: 'investments', name: 'Fidelity transfer' },
    { id: 'ira', date: '2026-09-02', amount: 7000, bucket: 'investments', name: 'IRA contribution', source: 'investment_transaction' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.total, 7000);
  assert.equal(result.preTaxRetirement, 7000);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].name, 'Fidelity transfer');
});

test('fixed costs stay limited to essential obligations', () => {
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 75, personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 400, personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 500, name: 'Payment Thank You', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), 'transfer');
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
  assert.equal(plan.standard, 1200000);
  assert.equal(plan.lean, 840000);
  assert.equal(plan.fat, 1800000);
  assert.ok(plan.coast < plan.standard);
  assert.ok(plan.projectedAtRetirement > 100000);
  assert.equal(plan.progress.standard, 100000 / 1200000 * 100);
});

test('each signed-in identity has an isolated persistent store', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-user-store-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  const store = await import(`../store.js?isolation=${Date.now()}`);
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
