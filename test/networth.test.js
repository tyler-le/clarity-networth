import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTransaction, hideDuplicateAccounts, removeEstimatedNetWorthHistory, seedDemo, snapshotNetWorth, spendingSummary } from '../finance.js';
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

test('demo mode provides seven years of usable account and spending history', () => {
  const store = { accounts: [], transactions: [], snapshots: [] };
  seedDemo(store);
  assert.ok(store.snapshots.length >= 84);
  assert.ok(new Set(store.transactions.map((transaction) => transaction.date.slice(0, 7))).size >= 84);
  assert.ok(store.accounts.some((account) => account.type === 'loan'));
});

test('a matching bank transfer and verified retirement contribution are not double-counted', () => {
  const store = { transactions: [
    { id: 'bank', date: '2026-09-01', amount: 7000, bucket: 'investments', name: 'Fidelity transfer' },
    { id: 'ira', date: '2026-09-02', amount: 7000, bucket: 'investments', name: 'IRA contribution', source: 'investment_transaction' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.total, 7000);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].name, 'IRA contribution');
});

test('fixed costs stay limited to essential obligations', () => {
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 100, personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 75, personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' } }), 'fixed');
  assert.equal(classifyTransaction({ amount: 400, personal_finance_category: { primary: 'TRAVEL', detailed: 'TRAVEL_FLIGHTS' } }), 'guilt_free');
  assert.equal(classifyTransaction({ amount: 500, name: 'Payment Thank You', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), 'transfer');
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
  assert.equal(store.readStore(partnerKey).accounts.length, 0);
  assert.notEqual(ownerKey, partnerKey);
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDataDir;
});
