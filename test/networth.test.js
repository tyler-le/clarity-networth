import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annualizedLivingSpend, applyCashFlowCategoryOverride, applyCashFlowCategoryRule, applyPeerPaymentCategorySuggestion, calculateFire, canonicalEconomicLedger, cashFlowType, cashRunway, classifyTransaction, clarityCheckin, connectionHealth, debtPayoffPlan, goalProgress, hideDuplicateAccounts, historicalSecurity, historicalTicker, investmentContributions, investmentDetailHistory, investmentLinkBalances, investmentPortfolioRangeProgress, investmentRangeProgress, monthlyFinancialFacts, monthlyReview, peerPaymentCategorySuggestion, previewCashFlowCategoryOverride, reconstructInvestmentHistory, refreshReconstructedInvestmentSnapshots, investmentSummary, recurringCharges, removeCashFlowCategoryRule, removeEstimatedNetWorthHistory, repairIncomingClassifications, repairTransferClassifications, seedDemo, snapshotInvestments, snapshotNetWorth, spendingSummary } from '../src/lib/finance.js';
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
  assert.deepEqual(result.categories, [{ name: 'Food & dining', amount: 80, share: 1, percentage: 100 }]);
  assert.deepEqual(result.topMerchants, [{ name: 'Cafe', amount: 80 }]);
});

test('a cash-flow category correction applies to every matching merchant payment and can replace an earlier rule', () => {
  const store = { transactions: [
    { id: 'latest-rent', date: '2026-09-15', amount: 1500, bucket: 'guilt_free', merchant_name: 'Zelle: Rent', pending: false },
    { id: 'prior-rent', date: '2026-08-15', amount: 1500, bucket: 'guilt_free', merchant_name: 'Zelle Rent', pending: false },
    { id: 'future-rent', date: '2026-10-15', amount: 1500, bucket: 'guilt_free', merchant_name: 'Zelle Rent', pending: false },
    { id: 'different-recipient', date: '2026-08-16', amount: 40, bucket: 'guilt_free', merchant_name: 'Zelle: Alex', pending: false },
    { id: 'explicit-choice', date: '2026-07-15', amount: 1500, bucket: 'guilt_free', merchant_name: 'Zelle Rent', pending: false, cash_flow_category: 'shopping', cash_flow_category_overridden: true }
  ] };
  const result = applyCashFlowCategoryOverride(store, 'latest-rent', 'housing_bills');
  assert.deepEqual({ updated: result.updated, matchedDuplicates: result.matchedDuplicates, category: result.category.key }, { updated: 4, matchedDuplicates: 3, category: 'housing_bills' });
  assert.deepEqual(store.cash_flow_category_rules, [{
    id: 'outflow:zelle:rent', merchant_key: 'zelle:rent', flow: 'outflow', category_key: 'housing_bills',
    created_at: store.cash_flow_category_rules[0].created_at, updated_at: store.cash_flow_category_rules[0].updated_at
  }]);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'latest-rent').bucket, 'fixed');
  assert.equal(store.transactions.find((transaction) => transaction.id === 'prior-rent').cash_flow_category, 'housing_bills');
  assert.equal(store.transactions.find((transaction) => transaction.id === 'different-recipient').cash_flow_category, undefined);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'explicit-choice').cash_flow_category, 'housing_bills');
  const changedAgain = applyCashFlowCategoryOverride(store, 'latest-rent', 'fees');
  assert.deepEqual({ updated: changedAgain.updated, matchedDuplicates: changedAgain.matchedDuplicates }, { updated: 4, matchedDuplicates: 3 });
  assert.deepEqual(store.transactions.filter((transaction) => transaction.id !== 'different-recipient').map((transaction) => transaction.cash_flow_category), ['fees', 'fees', 'fees', 'fees']);
  applyCashFlowCategoryOverride(store, 'latest-rent', 'housing_bills');
  assert.deepEqual(store.transactions.filter((transaction) => transaction.id !== 'different-recipient').map((transaction) => transaction.cash_flow_category), ['housing_bills', 'housing_bills', 'housing_bills', 'housing_bills']);
  const summary = spendingSummary(store, '3m', new Date('2026-09-20T12:00:00'));
  assert.equal(summary.transactions.find((transaction) => transaction.id === 'prior-rent').flowLabel, 'Housing & bills');
});

test('category changes can be reviewed first, and similar peer payments require an explicit opt-in', () => {
  const store = { transactions: [
    { id: 'sept', merchant_name: 'Venmo Jordan', name: 'Venmo Jordan', date: '2026-09-15', amount: 1000, bucket: 'guilt_free', pending: false },
    { id: 'aug', merchant_name: 'Venmo J. Smith', name: 'Venmo J. Smith', date: '2026-08-15', amount: 980, bucket: 'guilt_free', pending: false },
    { id: 'july', merchant_name: 'Venmo Housemate', name: 'Venmo Housemate', date: '2026-07-15', amount: 1020, bucket: 'guilt_free', pending: false },
    { id: 'wrong-rail', merchant_name: 'Zelle Sam', name: 'Zelle Sam', date: '2026-06-15', amount: 1000, bucket: 'guilt_free', pending: false },
    { id: 'one-off', merchant_name: 'Venmo Dinner', name: 'Venmo Dinner', date: '2026-09-18', amount: 60, bucket: 'guilt_free', pending: false }
  ] };
  const preview = previewCashFlowCategoryOverride(store, 'sept', 'housing_bills');
  assert.equal(preview.updated, 1);
  assert.equal(preview.matchedDuplicates, 0);
  assert.deepEqual(peerPaymentCategorySuggestion(store, 'sept', 'housing_bills').candidateIds.sort(), ['aug', 'july']);
  assert.equal(preview.similarPeerPayments.rail, 'Venmo');

  const onlyThis = applyCashFlowCategoryOverride(store, 'sept', 'housing_bills', { applyToMatches: false });
  assert.equal(onlyThis.updated, 1);
  assert.equal(store.cash_flow_category_rules, undefined);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'aug').cash_flow_category, undefined);

  const applied = applyPeerPaymentCategorySuggestion(store, 'sept', 'housing_bills');
  assert.equal(applied.updated, 2);
  assert.deepEqual(store.transactions.filter((transaction) => ['aug', 'july'].includes(transaction.id)).map((transaction) => transaction.cash_flow_category), ['housing_bills', 'housing_bills']);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'wrong-rail').cash_flow_category, undefined);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'one-off').cash_flow_category, undefined);
});

test('a remembered merchant rule applies to a new Plaid transaction and can be changed or forgotten', () => {
  const store = { transactions: [
    { id: 'rent', date: '2026-09-15', amount: 1500, bucket: 'guilt_free', merchant_name: 'Zelle: Rent', pending: false }
  ] };
  const first = applyCashFlowCategoryOverride(store, 'rent', 'housing_bills');
  assert.equal(first.rule.id, 'outflow:zelle:rent');

  // This matches the newly normalized record created by a later Plaid sync;
  // it has no historical, manually set category to preserve yet.
  const futurePlaidTransaction = {
    id: 'plaid-new-rent', date: '2026-10-15', amount: 1500, bucket: 'guilt_free',
    merchant_name: 'Zelle Rent', name: 'Zelle Rent', pending: false
  };
  assert.equal(applyCashFlowCategoryRule(store, futurePlaidTransaction), true);
  assert.equal(futurePlaidTransaction.cash_flow_category, 'housing_bills');
  assert.equal(futurePlaidTransaction.cash_flow_category_rule_id, first.rule.id);

  const changed = applyCashFlowCategoryOverride(store, 'rent', 'fees');
  assert.equal(changed.rule.id, first.rule.id);
  assert.equal(store.cash_flow_category_rules.length, 1);
  assert.equal(store.cash_flow_category_rules[0].category_key, 'fees');
  const futureAfterChange = { ...futurePlaidTransaction, id: 'plaid-new-rent-after-change', bucket: 'guilt_free', cash_flow_category: null, cash_flow_category_overridden: false };
  assert.equal(applyCashFlowCategoryRule(store, futureAfterChange), true);
  assert.equal(futureAfterChange.cash_flow_category, 'fees');

  assert.equal(removeCashFlowCategoryRule(store, first.rule.id), true);
  const futureAfterForget = { ...futurePlaidTransaction, id: 'plaid-new-rent-after-forget', bucket: 'guilt_free', cash_flow_category: null, cash_flow_category_overridden: false };
  assert.equal(applyCashFlowCategoryRule(store, futureAfterForget), false);
  assert.equal(futureAfterForget.cash_flow_category, null);
  assert.equal(removeCashFlowCategoryRule(store, first.rule.id), false);
});

test('remembered category rules never apply to refunds, transfers, or investment proceeds', () => {
  const store = {
    cash_flow_category_rules: [{ id: 'income:rent', merchant_key: 'rent', flow: 'income', category_key: 'income_business' }],
    transactions: []
  };
  for (const transaction of [
    { id: 'refund', amount: -50, bucket: 'income', merchant_name: 'Rent refund', pfc_detailed: 'MERCHANT_REFUND' },
    { id: 'transfer', amount: -1500, bucket: 'transfer', merchant_name: 'Rent transfer' },
    { id: 'sale', amount: -250, bucket: 'income', merchant_name: 'Rent proceeds', pfc_detailed: 'INVESTMENT_PROCEEDS' }
  ]) {
    assert.equal(applyCashFlowCategoryRule(store, transaction), false);
    assert.equal(transaction.cash_flow_category, undefined);
  }
});

test('peer payments stay visible and uncategorized until a person assigns their purpose', () => {
  const zelleRent = {
    amount: 1500, date: '2026-09-02',
    bucket: 'transfer',
    merchant_name: 'Zelle: Jordan rent',
    pfc_primary: 'TRANSFER_OUT',
    pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER'
  };
  const venmoGroceries = {
    amount: 72, date: '2026-09-03',
    bucket: 'transfer',
    counterparty_types: ['payment_app'],
    merchant_name: 'Payment to Jordan',
    pfc_primary: 'TRANSFER_OUT',
    pfc_detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER'
  };
  const store = { transactions: [zelleRent, venmoGroceries] };

  assert.equal(cashFlowType(zelleRent), 'external_outflow');
  assert.equal(cashFlowType(venmoGroceries), 'external_outflow');
  assert.equal(repairTransferClassifications(store), 2);
  assert.equal(zelleRent.bucket, 'guilt_free');
  assert.equal(venmoGroceries.bucket, 'guilt_free');
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.actualSpend, 1572);
  assert.deepEqual(result.actualSpendCategories, [{ key: 'uncategorized', name: 'Uncategorized', amount: 1572 }]);
});

test('physical check deposits stay visible as editable other money in without teaching a generic deposit rule', () => {
  const checkDeposit = {
    id: 'physical-check', amount: -2100, date: '2026-09-03', bucket: 'transfer',
    merchant_name: 'Mobile check deposit', transaction_code: 'cheque',
    pfc_primary: 'TRANSFER_IN', pfc_detailed: 'TRANSFER_IN_ACCOUNT_TRANSFER'
  };
  const store = { transactions: [checkDeposit] };

  assert.equal(cashFlowType(checkDeposit), 'external_inflow');
  assert.equal(classifyTransaction(checkDeposit), 'income');
  assert.equal(repairTransferClassifications(store), 1);
  assert.equal(checkDeposit.bucket, 'income');
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.deepEqual(result.incomeSources, [{ key: 'money_in_other', label: 'Other money in', amount: 2100 }]);
  const update = applyCashFlowCategoryOverride(store, 'physical-check', 'income_paychecks');
  assert.equal(update.rule, null);
  assert.equal(checkDeposit.cash_flow_category, 'income_paychecks');
});

test('an income category rule updates every matching deposit without recategorizing protected inflows', () => {
  const store = { transactions: [
    { id: 'current-gig', date: '2026-09-15', amount: -900, bucket: 'income', merchant_name: 'Acme Design LLC', pending: false },
    { id: 'older-gig', date: '2026-08-15', amount: -750, bucket: 'income', merchant_name: 'Acme Design LLC', pending: false },
    { id: 'newer-gig', date: '2026-10-15', amount: -1_050, bucket: 'income', merchant_name: 'Acme Design LLC', pending: false },
    { id: 'refund', date: '2026-09-12', amount: -30, bucket: 'income', merchant_name: 'Acme Design LLC refund', pfc_detailed: 'MERCHANT_REFUND', pending: false },
    { id: 'loan', date: '2026-09-11', amount: -1000, bucket: 'income', merchant_name: 'Acme Design LLC loan', pfc_detailed: 'LOAN_PROCEEDS', pending: false }
  ] };
  const result = applyCashFlowCategoryOverride(store, 'current-gig', 'income_business');
  assert.deepEqual({ updated: result.updated, matchedDuplicates: result.matchedDuplicates, category: result.category.key }, { updated: 3, matchedDuplicates: 2, category: 'income_business' });
  assert.deepEqual(store.transactions.filter((transaction) => transaction.id.endsWith('gig')).map((transaction) => transaction.cash_flow_category), ['income_business', 'income_business', 'income_business']);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'refund').cash_flow_category, undefined);
  assert.equal(store.transactions.find((transaction) => transaction.id === 'loan').cash_flow_category, undefined);
  assert.equal(applyCashFlowCategoryOverride(store, 'refund', 'income_business'), null);
  const summary = spendingSummary(store, 'all', new Date('2026-10-20T12:00:00'));
  assert.equal(summary.transactions.find((transaction) => transaction.id === 'older-gig').category, 'Business & freelance');
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
  assert.deepEqual(result.monthly, [{ month: '2026-09', amount: 900, actual_spend: 900, saved_invested: 0, income: 4200, pre_tax_retirement: 0 }]);
  assert.deepEqual(result.transactions.find((transaction) => transaction.category === 'Paychecks'), {
    id: undefined, name: 'Payroll', date: '2026-09-01', amount: 4200, category: 'Paychecks', bucket: 'income', cashFlowCategory: 'income_paychecks', categoryRuleId: null, flowKey: 'income_paychecks', flowLabel: 'Paychecks', flowGroup: 'income'
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

test('cash flow keeps every posted non-transfer inbound credit, even when Plaid assigns a purchase category', () => {
  const incomingCredit = {
    date: '2026-02-12', amount: -10440.38, bucket: 'guilt_free',
    pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', merchant_name: 'Employer payout'
  };
  const transferIn = {
    date: '2026-02-13', amount: -500, bucket: 'guilt_free',
    pfc_primary: 'TRANSFER_IN', pfc_detailed: 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS', merchant_name: 'Investment transfer'
  };
  const memberChoice = { ...incomingCredit, date: '2026-02-14', amount: -60, bucket: 'guilt_free', category_overridden: true };
  const store = { transactions: [incomingCredit, transferIn, memberChoice, { date: '2026-02-15', amount: 8000, bucket: 'investments', merchant_name: 'Brokerage contribution' }] };

  assert.equal(classifyTransaction(incomingCredit), 'income');
  assert.equal(classifyTransaction(transferIn), 'transfer');
  assert.ok(repairIncomingClassifications(store) >= 1);
  assert.equal(incomingCredit.bucket, 'income');
  assert.equal(transferIn.bucket, 'guilt_free'); // Its provider transfer category is intentionally left for transfer repair.
  assert.equal(memberChoice.bucket, 'guilt_free');
  assert.equal(repairTransferClassifications(store), 1);
  assert.equal(transferIn.bucket, 'transfer');
  const result = spendingSummary(store, '1m', new Date('2026-02-28T12:00:00'));
  // A member may choose a display category, but that must not change the
  // signed-ledger fact that external money entered their accounts.
  assert.equal(result.income, 10500.38);
  assert.equal(result.investments, 8000);
  assert.equal(result.total, 8000);
});

test('account detail exposes each holding’s selected-range verified performance', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', name: 'IRA', type: 'investment', current_balance: 2_300, hidden: false }],
    positions: [
      { id: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', name: 'Total stock', type: 'etf', quantity: 10, price: 110, value: 1_100 },
      { id: 'ira:bnd', account_id: 'ira', security_id: 'bnd', ticker: 'BND', name: 'Total bond', type: 'etf', quantity: 10, price: 120, value: 1_200 }
    ],
    investment_position_snapshots: [
      { date: '2026-09-01', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', quantity: 10, price: 100, value: 1_000, source: 'verified' },
      { date: '2026-09-12', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', quantity: 10, price: 110, value: 1_100, source: 'verified' },
      { date: '2026-09-01', kind: 'holding', key: 'ira:bnd', account_id: 'ira', security_id: 'bnd', ticker: 'BND', quantity: 10, price: 125, value: 1_250, source: 'verified' },
      { date: '2026-09-12', kind: 'holding', key: 'ira:bnd', account_id: 'ira', security_id: 'bnd', ticker: 'BND', quantity: 10, price: 120, value: 1_200, source: 'verified' },
      { date: '2026-09-01', kind: 'account', key: 'ira', account_id: 'ira', value: 2_250, source: 'verified' },
      { date: '2026-09-12', kind: 'account', key: 'ira', account_id: 'ira', value: 2_300, source: 'verified' }
    ]
  };
  const detail = investmentDetailHistory(store, { accountId: 'ira', range: '1m' });
  assert.equal(detail.holdingProgress['ira:vti'].marketChange, 100);
  assert.equal(detail.holdingProgress['ira:bnd'].marketChange, -50);
  assert.equal(detail.holdingProgress['ira:vti'].range, '1m');
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

test('all cash flow uses the complete observed ledger, including the current month', () => {
  const store = { transactions: [
    { date: '2024-01-03', amount: -2_000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2024-01-04', amount: 800, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-09-04', amount: -2_500, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-05', amount: 900, bucket: 'guilt_free', merchant_name: 'Grocer' }
  ] };
  const result = spendingSummary(store, 'all', new Date('2026-09-05T12:00:00'));
  assert.equal(result.range, 'all');
  assert.equal(result.startDate, '2024-01-03');
  assert.equal(result.endDate, '2026-09-05');
  assert.equal(result.completedMonths, false);
  assert.equal(result.income, 4_500);
  assert.equal(result.total, 1_700);
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
  assert.equal(result.savedInvested, 750);
  assert.deepEqual(result.actualSpendCategories.map((row) => [row.key, row.amount]), [['housing_bills', 1800], ['food_dining', 240], ['shopping', 90]]);
});

test('cash-flow funding sources reconcile allocations without inventing paycheck flow', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -1000, bucket: 'income', merchant_name: 'Payroll' },
    { date: '2026-09-02', amount: 1200, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-09-03', amount: 500, bucket: 'investments', merchant_name: 'Brokerage transfer' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.savedInvested, 500);
  assert.deepEqual(result.cashFlowFundingSources, [
    { key: 'income_paychecks', label: 'Paychecks', amount: 1000 },
    { key: 'existing_funds', label: 'Existing balances / timing', amount: 700 }
  ]);
  assert.equal(result.cashFlowFundingSources.reduce((sum, source) => sum + source.amount, 0), result.actualSpend + result.savedInvested);
});

test('cash-flow headline subtracts actual spend only', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -5000, bucket: 'income', merchant_name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2026-09-02', amount: 2000, bucket: 'fixed', merchant_name: 'Rent' },
    { date: '2026-09-03', amount: 500, bucket: 'guilt_free', merchant_name: 'Food' },
    { date: '2026-09-04', amount: 1000, bucket: 'savings', merchant_name: 'Savings transfer' },
    { date: '2026-09-05', amount: 1000, bucket: 'investments', merchant_name: 'Brokerage transfer' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 5000);
  assert.equal(result.actualSpend, 2500);
  assert.equal(result.savingsAndInvestments, 2000);
  assert.equal(result.netCashFlow, 2500);
});

test('credit-card purchase and payment count as one economic expense', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: 100, bucket: 'guilt_free', merchant_name: 'Restaurant', pfc_primary: 'FOOD_AND_DRINK' },
    { date: '2026-09-02', amount: 100, bucket: 'transfer', merchant_name: 'Payment Thank You', pfc_primary: 'LOAN_PAYMENTS', pfc_detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.actualSpend, 100);
  assert.equal(result.total, 100);
});

test('attributable refunds reduce spending and never become income', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: 100, bucket: 'guilt_free', merchant_name: 'Store', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' },
    { date: '2026-09-03', amount: -40, bucket: 'guilt_free', merchant_name: 'Store refund', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_REFUND' },
    { date: '2026-09-04', amount: -5000, bucket: 'income', merchant_name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 5000);
  assert.equal(result.actualSpend, 60);
  assert.equal(result.netCashFlow, 4940);
  assert.deepEqual(result.actualSpendCategories.map((row) => [row.key, row.amount]), [['shopping', 60]]);
});

test('a full attributable refund brings the category and spend to zero', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: 100, bucket: 'guilt_free', merchant_name: 'Store', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' },
    { date: '2026-09-02', amount: -100, bucket: 'guilt_free', merchant_name: 'Store refund', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_REFUND' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 0);
  assert.equal(result.actualSpend, 0);
  assert.equal(result.netCashFlow, 0);
  assert.deepEqual(result.actualSpendCategories, []);
});

test('unknown inflows and investment sale proceeds are not silently counted as income', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -1000, bucket: 'guilt_free', merchant_name: 'Unknown deposit' },
    { date: '2026-09-02', amount: -2500, bucket: 'guilt_free', merchant_name: 'Sell VTI', pfc_primary: 'GENERAL', pfc_detailed: 'GENERAL_OTHER' }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 0);
  assert.equal(result.actualSpend, 0);
  assert.equal(result.netCashFlow, 0);
  assert.equal(classifyTransaction(store.transactions[1]), 'investment_proceeds');
});

test('pending transactions are excluded from finalized cash flow', () => {
  const store = { transactions: [
    { date: '2026-09-01', amount: -5000, bucket: 'income', merchant_name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2026-09-02', amount: 300, bucket: 'guilt_free', merchant_name: 'Pending store', pending: true }
  ] };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.income, 5000);
  assert.equal(result.actualSpend, 0);
  assert.equal(result.transactions.some((row) => row.name === 'Pending store'), false);
});

test('post-tax Sankey saving excludes payroll deferrals and moves within invested accounts', () => {
  const store = {
    accounts: [
      { id: 'checking', type: 'depository', subtype: 'checking' },
      { id: 'brokerage', type: 'investment', subtype: 'brokerage' }
    ],
    transactions: [
      { id: 'cash-to-brokerage', date: '2026-09-01', account_id: 'checking', amount: 500, bucket: 'investments', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
      { id: 'brokerage-rebalance', date: '2026-09-02', account_id: 'brokerage', amount: 800, bucket: 'investments', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
      { id: 'payroll-deferral', date: '2026-09-03', account_id: 'brokerage', amount: 1000, bucket: 'investments', source: 'investment_transaction' }
    ]
  };
  const result = spendingSummary(store, '1m', new Date('2026-09-05T12:00:00'));
  assert.equal(result.savedInvested, 500);
  assert.deepEqual(result.transactions.filter((row) => row.flowGroup === 'save_invest').map((row) => [row.id, row.amount]), [['cash-to-brokerage', 500]]);
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
    requestedStartDate: '2026-08-07', startDate: '2026-08-10', endDate: '2026-09-07', startValue: 1_000, endValue: 1_100, valueChange: 100,
    marketChange: 100, marketChangePct: .1, changeKind: 'market'
  });
});

test('portfolio range progress gives the overview one verified date window', () => {
  const store = { investment_snapshots: [
    { date: '2026-08-11', value: 17_800, source: 'verified' },
    { date: '2026-08-12', value: 17_968.64, source: 'verified' },
    { date: '2026-08-30', value: 18_241, source: 'verified' },
    { date: '2026-09-12', value: 18_200, source: 'verified' }
  ] };
  assert.deepEqual(investmentPortfolioRangeProgress(store, { range: '1m' }), {
    scope: 'portfolio', range: '1m', state: 'ready', points: 3, basis: 'aggregate_snapshots',
    requestedStartDate: '2026-08-12', startDate: '2026-08-12', endDate: '2026-09-12', startValue: 17_968.64,
    endValue: 18_200, valueChange: 231.36, changeKind: 'balance'
  });
  const summary = investmentSummary({ ...store, accounts: [], positions: [], manual_holdings: [] }, { range: '1m' });
  assert.deepEqual(summary.progress, investmentPortfolioRangeProgress(store, { range: '1m' }));
});

test('portfolio and account performance share one complete verified snapshot window', () => {
  const store = {
    accounts: [
      { plaid_account_id: 'roth', type: 'investment', current_balance: 1_100 },
      { plaid_account_id: '401k', type: 'investment', current_balance: 1_900 }
    ],
    // This legacy aggregate is deliberately wrong. The visible summary must
    // derive from the complete account ledger, not whichever aggregate row
    // happened to be stored first.
    investment_snapshots: [
      { date: '2026-08-13', value: 3_400, source: 'verified' },
      { date: '2026-09-12', value: 3_900, source: 'verified' }
    ],
    investment_position_snapshots: [
      { date: '2026-08-13', kind: 'account', key: 'roth', account_id: 'roth', value: 1_000, source: 'verified' },
      { date: '2026-08-13', kind: 'account', key: '401k', account_id: '401k', value: 2_000, source: 'verified' },
      { date: '2026-09-12', kind: 'account', key: 'roth', account_id: 'roth', value: 1_100, source: 'verified' },
      { date: '2026-09-12', kind: 'account', key: '401k', account_id: '401k', value: 1_900, source: 'verified' }
    ],
    positions: [], manual_holdings: []
  };
  const summary = investmentSummary(store, { range: '1m' });
  assert.deepEqual(summary.snapshots, [
    { date: '2026-08-13', value: 3_000, source: 'verified', basis: 'account_snapshots' },
    { date: '2026-09-12', value: 3_000, source: 'verified', basis: 'account_snapshots' }
  ]);
  assert.equal(summary.progress.basis, 'account_snapshots');
  assert.equal(summary.progress.valueChange, 0);
  assert.deepEqual(summary.accounts.map((account) => account.rangeProgress.valueChange), [100, -100]);
  assert.equal(summary.accounts.reduce((sum, account) => sum + account.rangeProgress.valueChange, 0), summary.progress.valueChange);
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

test('investment summaries attach the requested observed range to holdings', () => {
  const store = {
    accounts: [{ id: 'ira', plaid_account_id: 'ira', name: 'IRA', type: 'investment', current_balance: 1100 }],
    positions: [{ id: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', name: 'VTI', type: 'etf', quantity: 10, value: 1100 }],
    investment_position_snapshots: [
      { date: '2026-08-10', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', quantity: 10, price: 100, value: 1000, source: 'verified' },
      { date: '2026-09-07', kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'vti', ticker: 'VTI', quantity: 10, price: 110, value: 1100, source: 'verified' }
    ]
  };
  const result = investmentSummary(store, { range: '1m' });
  assert.equal(result.positions[0].rangeProgress.range, '1m');
  assert.equal(result.positions[0].rangeProgress.marketChange, 100);
});

test('a holding never borrows a same-ticker snapshot from another account', () => {
  const store = {
    accounts: [
      { plaid_account_id: 'hsa', name: 'HSA', type: 'investment', current_balance: 5_711, hidden: false },
      { plaid_account_id: 'old-401k', name: 'Old 401(k)', type: 'investment', current_balance: 39_042, hidden: false }
    ],
    // The current position belongs only to the HSA. A shared fund ticker is
    // not enough to assign the old 401(k)'s history to this position.
    positions: [{ id: 'hsa:vx', account_id: 'hsa', security_id: 'vx', ticker: 'VXLVX', name: 'Target Fund', type: 'mutual fund', quantity: 10, price: 571.1, value: 5_711 }],
    investment_position_snapshots: [
      { date: '2026-08-10', kind: 'holding', key: 'hsa:vx', account_id: 'hsa', security_id: 'vx', ticker: 'VXLVX', quantity: 10, price: 500, value: 5_000, source: 'verified' },
      { date: '2026-08-20', kind: 'holding', key: 'old-401k:vx', account_id: 'old-401k', security_id: 'vx', ticker: 'VXLVX', quantity: 70, price: 557.74, value: 39_042, source: 'verified' },
      { date: '2026-09-07', kind: 'holding', key: 'hsa:vx', account_id: 'hsa', security_id: 'vx', ticker: 'VXLVX', quantity: 10, price: 571.1, value: 5_711, source: 'verified' }
    ]
  };
  const detail = investmentDetailHistory(store, { ticker: 'VXLVX', range: '1m' });
  assert.deepEqual(detail.history, [{ date: '2026-08-10', value: 5_000 }, { date: '2026-09-07', value: 5_711 }]);
  assert.equal(detail.progress.marketChange, 711);
  assert.equal(investmentSummary(store, { range: '1m' }).positions[0].rangeProgress.marketChange, 711);
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
  assert.match(detail.detail, /verified daily update/i);
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

test('an account without two verified daily snapshots does not reconstruct a deposit balance', () => {
  const store = {
    accounts: [{ plaid_account_id: 'brokerage', type: 'investment', current_balance: 100 }],
    positions: [{ account_id: 'brokerage', security_id: 'cash', ticker: 'CASH', type: 'cash', quantity: 100, price: 1, value: 100 }],
    investment_transactions: [{ account_id: 'brokerage', security_id: 'cash', ticker: 'CASH', security_type: 'cash', date: '2026-01-15', quantity: 100 }],
    market_prices: {}, investment_position_snapshots: []
  };
  const result = investmentDetailHistory(store, { accountId: 'brokerage', years: 1 });
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.history, []);
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
      { date: '2026-01-15', kind: 'holding', key: 'brokerage:vti', account_id: 'brokerage', ticker: 'VTI', value: 1000, source: 'verified' },
      { date: '2026-09-01', kind: 'holding', key: 'brokerage:vti', account_id: 'brokerage', ticker: 'VTI', value: 1100, source: 'verified' }
    ]
  };
  const result = investmentDetailHistory(store, { ticker: 'VTI', years: 1 });
  assert.equal(result.state, 'ready');
  assert.equal(result.value, 1100);
  assert.equal(result.gain, null);
  assert.deepEqual(result.market, []);
  assert.deepEqual(result.history, [{ date: '2026-01-15', value: 1000 }, { date: '2026-09-01', value: 1100 }]);
});

test('reported trades and prices never create an observed account history', () => {
  const store = {
    accounts: [{ plaid_account_id: '401k', type: 'investment', name: 'Work 401(k)', hidden: false }],
    positions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', name: 'Fund', type: 'etf', quantity: 5, value: 550 }],
    investment_transactions: [{ account_id: '401k', security_id: 'fund', ticker: 'VTI', date: '2026-01-15', quantity: 5 }],
    market_prices: { VTI: { '2025-12-31': 95, '2026-01-15': 100, '2026-09-01': 110 } }
  };
  const result = investmentDetailHistory(store, { accountId: '401k', years: 1 });
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.history, []);
});

test('a later holding does not create an account timeline without daily snapshots', () => {
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
  assert.equal(result.state, 'unavailable');
  assert.deepEqual(result.history, []);
});

test('sold holdings do not create an account timeline without daily snapshots', () => {
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
  assert.equal(detail.state, 'unavailable');
  assert.deepEqual(detail.history, []);

  const portfolio = refreshReconstructedInvestmentSnapshots(store, '2026-09-01', 1);
  assert.deepEqual(portfolio, []);
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
  assert.match(detail.reason, /daily account tracking/i);
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
  assert.match(result.reason, /daily account tracking/i);
});

test('portfolio history never reconstructs from investment activity', () => {
  const store = {
    accounts: [{ plaid_account_id: 'ira', type: 'investment', current_balance: 1100, hidden: false }],
    positions: [{ account_id: 'ira', security_id: 'fund', ticker: 'VFINX', type: 'mutual fund', quantity: 10, value: 1100 }],
    investment_transactions: [{ account_id: 'ira', security_id: 'fund', ticker: 'VFINX', date: '2026-09-03', quantity: 10 }],
    market_prices: { VFINX: { '2025-09-01': 90, '2026-09-01': 100, '2026-09-05': 110 } },
    investment_snapshots: []
  };
  const history = refreshReconstructedInvestmentSnapshots(store, '2026-09-05', 1);
  assert.deepEqual(history, []);
  assert.deepEqual(store.investment_snapshots, []);
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
  assert.ok(store.snapshots.length >= 84 * 30);
  assert.equal(Date.parse(`${store.snapshots[1].date}T12:00:00Z`) - Date.parse(`${store.snapshots[0].date}T12:00:00Z`), 86_400_000, 'demo net-worth snapshots are daily');
  assert.ok(new Set(store.transactions.map((transaction) => transaction.date.slice(0, 7))).size >= 84);
  assert.ok(store.accounts.some((account) => account.type === 'loan'));
  const snapshots = store.investment_snapshots;
  assert.equal(Date.parse(`${snapshots[1].date}T12:00:00Z`) - Date.parse(`${snapshots[0].date}T12:00:00Z`), 86_400_000, 'demo portfolio snapshots are daily');
  const portfolioChange = snapshots.at(-1).value - snapshots[0].value;
  assert.ok(portfolioChange > 0, 'demo all-time portfolio change should be positive');
  const accountNetWorth = store.accounts.reduce((total, account) => total + (['credit', 'loan'].includes(account.type) ? -1 : 1) * Math.abs(Number(account.current_balance || 0)), 0);
  const investmentBalance = store.accounts.filter((account) => account.type === 'investment').reduce((total, account) => total + Math.abs(Number(account.current_balance || 0)), 0);
  assert.equal(store.snapshots.at(-1).net_worth, accountNetWorth, 'latest chart point reconciles to demo accounts');
  assert.equal(snapshots.at(-1).value, investmentBalance, 'portfolio chart reconciles to demo investment accounts');
  const vti = store.positions.filter((position) => position.ticker === 'VTI');
  const vtiProgress = investmentRangeProgress(store, { ticker: 'VTI', holdingKeys: vti.map((position) => position.id), range: 'all' });
  const vtiHistory = investmentDetailHistory(store, { ticker: 'VTI', range: 'all' }).history;
  assert.deepEqual(
    { startValue: vtiProgress.startValue, endValue: vtiProgress.endValue, marketChange: vtiProgress.marketChange },
    { startValue: vtiHistory[0].value, endValue: vtiHistory.at(-1).value, marketChange: vtiHistory.at(-1).value - vtiHistory[0].value },
    'the combined demo VTI position must use its recorded opening and closing snapshots'
  );
  assert.ok(vtiProgress.marketChange > 0, 'the all-time demo VTI fixture remains a positive long-term example');
  assert.equal(investmentSummary(store).allocation.some((row) => row.name === 'Cash & unclassified'), false);
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
  assert.equal(result.transactions.find((transaction) => transaction.name === 'Fidelity transfer').flowGroup, 'save_invest');
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
  assert.equal(health[0].last_verified_update_at, '2026-09-05T10:00:00.000Z');
  assert.equal(health[0].update_source, 'successful_sync');
  assert.equal(health[4].action, 'automatic_retry');
  assert.equal(health[5].action, 'reconnect');
  assert.equal(health[5].action_required, true);
  assert.equal(health[6].update_source, 'legacy_account_record');
});

test('retirement presets calculate coast, lean, standard, fat, and a projected retirement value', () => {
  const store = {
    settings: { fire: { age: 35, retirement_age: 65, withdrawal_rate: 4, real_return: 5, lean_multiplier: 70, fat_multiplier: 150 } },
    transactions: [
      { date: '2026-08-01', amount: 3000, bucket: 'fixed' },
      { date: '2026-08-02', amount: 1000, bucket: 'guilt_free' },
      { date: '2026-08-03', amount: 500, bucket: 'investments' },
      { date: '2026-08-04', amount: 250, bucket: 'savings' }
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
  assert.equal(plan.monthlyContributions, 500 / 12);
  assert.equal(plan.lifestyles[0].target, 900000);
  assert.equal(plan.ladder[0].target, 9000);
  assert.equal(plan.ladder[1].target, 18000);
  assert.equal(plan.ladder[0].estimatedMonths, 433);
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

  const noPortfolioWithdrawals = calculateFire({ ...store, settings: { fire: { ...store.settings.fire, withdrawal_rate: 0, real_return: 0 } } }, 100000);
  assert.equal(noPortfolioWithdrawals.withdrawalRate, 0);
  assert.equal(noPortfolioWithdrawals.realReturn, 0);
  assert.equal(noPortfolioWithdrawals.standard, 0, '0% means the plan does not assume portfolio-funded spending');
  assert.ok(Number.isFinite(noPortfolioWithdrawals.projectedAtRetirement));
  assert.ok(Number.isFinite(noPortfolioWithdrawals.lifestyles[0].target), '0% withdrawal does not produce an infinite essentials target');

  const noHistoryPlan = calculateFire({ ...store, transactions: [] }, 100000);
  assert.equal(noHistoryPlan.monthlyContributions, 0, 'an account without posted transactions has no observed saving pace');
  assert.equal(noHistoryPlan.essentialMonthlySpend, 0, 'an account without posted transactions has no observed essential spending');

  const outlierResistantPlan = calculateFire({
    ...store,
    transactions: [
      ...Array.from({ length: 12 }, (_, index) => ({ date: `2025-${String(index + 1).padStart(2, '0')}-15`, amount: 100, bucket: 'fixed' })),
      ...Array.from({ length: 12 }, (_, index) => ({ date: `2025-${String(index + 1).padStart(2, '0')}-20`, amount: index === 5 ? 1300 : 100, bucket: 'investments' })),
      { date: '2025-06-25', amount: 10000, bucket: 'fixed' }
    ]
  }, 100000);
  assert.equal(outlierResistantPlan.contributionMonthsObserved, 12);
  assert.equal(outlierResistantPlan.monthlyContributions, 200, 'the observed annual contribution pace includes the one-off contribution');
  assert.equal(outlierResistantPlan.annualContributions, 2400);
  assert.equal(outlierResistantPlan.essentialMonthlySpend, 11200 / 12, 'a genuine annual essential expense is preserved in the retirement target');

  const now = new Date();
  const completedMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 7);
  const currentMonth = now.toISOString().slice(0, 7);
  const partialMonthPlan = calculateFire({
    ...store,
    transactions: [
      { date: `${completedMonth}-15`, amount: 100, bucket: 'fixed' },
      { date: `${completedMonth}-20`, amount: 100, bucket: 'investments' },
      { date: `${currentMonth}-01`, amount: 10000, bucket: 'investments' }
    ]
  }, 100000);
  assert.equal(partialMonthPlan.contributionMonthsObserved, 1, 'an in-progress month is not treated as a completed retirement input');
  assert.equal(partialMonthPlan.monthlyContributions, 100 / 12);

  const fasterSaver = calculateFire({
    ...store,
    transactions: [
      ...store.transactions.map((transaction) => transaction.bucket === 'investments' ? { ...transaction, amount: 1000 } : transaction),
      ...Array.from({ length: 11 }, (_, index) => ({ date: new Date(Date.UTC(2025, 8 + index, 20)).toISOString().slice(0, 10), amount: 1000, bucket: 'investments' })),
      ...Array.from({ length: 11 }, (_, index) => ({ date: new Date(Date.UTC(2025, 8 + index, 10)).toISOString().slice(0, 10), amount: 4000, bucket: 'guilt_free' }))
    ]
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

test('cash flow and retirement share canonical spend, refunds, and contributions', () => {
  const store = {
    accounts: [
      { id: 'checking', type: 'depository', subtype: 'checking' },
      { id: 'brokerage', type: 'investment', subtype: 'brokerage' }
    ],
    transactions: [
      { id: 'rent', date: '2026-08-01', amount: 2000, bucket: 'fixed', merchant_name: 'Rent', pfc_primary: 'RENT_AND_UTILITIES' },
      { id: 'food', date: '2026-08-02', amount: 100, bucket: 'guilt_free', merchant_name: 'Market', pfc_primary: 'FOOD_AND_DRINK' },
      { id: 'refund', date: '2026-08-03', amount: -40, bucket: 'guilt_free', merchant_name: 'Market refund', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_REFUND' },
      { id: 'saving', date: '2026-08-04', amount: 1000, bucket: 'savings', account_id: 'checking', pfc_detailed: 'TRANSFER_OUT_SAVINGS' },
      { id: 'investing', date: '2026-08-05', amount: 500, bucket: 'investments', account_id: 'checking', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
      { id: 'payroll-deferral', date: '2026-08-06', amount: 300, bucket: 'investments', account_id: 'brokerage', source: 'investment_transaction', name: '401(k) payroll contribution' },
      { id: 'paycheck', date: '2026-08-07', amount: -5000, bucket: 'income', merchant_name: 'Employer payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' }
    ]
  };
  const cash = spendingSummary(store, '1m', new Date('2026-08-31T12:00:00'));
  const facts = monthlyFinancialFacts(store);
  const ledger = canonicalEconomicLedger(store);
  assert.equal(cash.income, 5000);
  assert.equal(cash.actualSpend, 2060);
  assert.equal(cash.savings, 1000);
  assert.equal(cash.investments, 500);
  assert.equal(cash.netCashFlow, 2940);
  assert.equal(facts[0].actualSpend, 2060);
  assert.equal(facts[0].essentialSpend, 2000);
  assert.equal(facts[0].investmentContributions, 800);
  assert.equal(ledger.find((row) => row.id === 'payroll-deferral').economicType, 'payroll_retirement_contribution');
  assert.equal(ledger.find((row) => row.id === 'refund').economicType, 'refund');
  const retirement = annualizedLivingSpend(store);
  assert.equal(retirement.monthsObserved, 1);
  assert.equal(retirement.monthlyAverage, 2060);
});

test('retirement preserves a genuine annual expense and irregular annual contribution', () => {
  const transactions = [];
  for (let month = 1; month <= 12; month += 1) {
    const mm = String(month).padStart(2, '0');
    transactions.push({ date: `2025-${mm}-15`, amount: month === 12 ? 8000 : 4000, bucket: 'guilt_free', pfc_primary: 'GENERAL_MERCHANDISE', merchant_name: month === 12 ? 'Annual insurance' : 'Living costs' });
  }
  transactions.push({ date: '2025-01-20', amount: 7000, bucket: 'investments', account_id: 'checking', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' });
  const store = { accounts: [{ id: 'checking', type: 'depository' }], transactions };
  const spend = annualizedLivingSpend(store);
  assert.equal(spend.monthsObserved, 12);
  assert.equal(spend.annualSpend, 52000);
  assert.equal(spend.monthlyAverage, 52000 / 12);
  const plan = calculateFire(store, 0);
  assert.equal(plan.annualContributions, 7000);
  assert.equal(plan.monthlyContributions, 7000 / 12);
});

test('retirement plan uses the selected completed-month history window for spend and contributions', () => {
  const now = new Date();
  const transactions = [];
  for (let offset = 12; offset >= 1; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 15)).toISOString().slice(0, 10);
    const recent = offset <= 6;
    transactions.push({ date, amount: recent ? 600 : 100, bucket: 'guilt_free', pfc_primary: 'GENERAL_MERCHANDISE' });
    transactions.push({ date, amount: recent ? 200 : 50, bucket: 'investments', account_id: 'checking', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' });
  }
  const plan = calculateFire({
    settings: { fire: { age: 30, retirement_age: 65, withdrawal_rate: 4, real_return: 5, trailing_months: 6 } },
    accounts: [{ id: 'checking', type: 'depository' }],
    transactions
  }, 0);
  assert.equal(plan.trailingMonths, 6);
  assert.equal(plan.monthsObserved, 6);
  assert.equal(plan.monthlySpend, 600);
  assert.equal(plan.monthlyContributions, 200);
  assert.equal(plan.annualContributions, 2400);
});

test('retirement contribution forecast keeps recurring pace separate from historical windfalls', () => {
  const transactions = [
    { date: '2025-01-15', amount: -5000, bucket: 'income', name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2025-01-20', amount: 4000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { date: '2025-02-15', amount: -5000, bucket: 'income', name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2025-02-20', amount: 4000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { date: '2025-03-15', amount: -25000, bucket: 'income', name: 'Severance payout', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_OTHER' },
    { date: '2025-03-20', amount: 20000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { date: '2025-04-15', amount: -5000, bucket: 'income', name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2025-04-20', amount: 4000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { date: '2025-05-15', amount: -5000, bucket: 'income', name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2025-05-20', amount: 4000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
    { date: '2025-06-15', amount: -5000, bucket: 'income', name: 'Payroll', pfc_primary: 'INCOME', pfc_detailed: 'INCOME_PAYCHECK' },
    { date: '2025-06-20', amount: 4000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'brokerage', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' }
  ];
  const store = { accounts: [{ id: 'checking', type: 'depository' }], transactions };
  const plan = calculateFire(store, 100000);
  assert.equal(plan.annualContributions, 40000);
  assert.equal(plan.ongoingAnnualContributions, 48000);
  assert.equal(plan.ongoingMonthlyContributions, 4000);
  assert.equal(plan.contributionStreams[0].behavior, 'recurring');
  assert.equal(plan.contributionEstimateQuality, 'medium');
  const years = plan.retirementAge - plan.age;
  const futureValueFactor = (Math.pow(1.05, years) - 1) / 0.05;
  assert.equal(plan.projectedAtRetirement, 100000 * Math.pow(1.05, years) + plan.annualContributions * futureValueFactor, 'retirement outlook uses the exact observed trailing contribution total');
});

test('retirement contribution forecast does not annualize an isolated contribution', () => {
  const plan = calculateFire({
    transactions: [{ date: '2025-06-15', amount: 7000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'ira', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' }]
  }, 100000);
  assert.equal(plan.annualContributions, 7000);
  assert.equal(plan.ongoingAnnualContributions, 0);
  assert.equal(plan.ongoingMonthlyContributions, 0);
  assert.equal(plan.contributionStreams[0].behavior, 'one_time');
});

test('retirement contribution forecast preserves an established annual IRA pattern', () => {
  const plan = calculateFire({
    transactions: [
      { date: '2025-01-15', amount: 7000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'ira', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' },
      { date: '2026-01-15', amount: 7000, bucket: 'investments', account_id: 'checking', investment_contribution_account_id: 'ira', pfc_detailed: 'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS' }
    ]
  }, 100000);
  assert.equal(plan.ongoingAnnualContributions, 7000);
  assert.equal(plan.ongoingMonthlyContributions, 7000 / 12);
  assert.equal(plan.contributionStreams[0].behavior, 'recurring_lumpy');
  assert.equal(plan.contributionStreams[0].cadence, 'annual');
});
