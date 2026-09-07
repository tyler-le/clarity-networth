import test from 'node:test';
import assert from 'node:assert/strict';
import { combinedHistory, mergeReportedHistory, priceAt, reconstructCashAccount, reconstructInvestmentAccount, reconstructedNetWorth } from '../src/lib/history.js';
import { investmentDetailHistory, refreshReconstructedInvestmentSnapshots } from '../src/lib/finance.js';
import { investmentLedgerPages } from '../src/lib/plaid.js';
import { loadHistoricalPrices } from '../src/lib/market-data.js';

const today = '2026-09-07';
const usd = { iso_currency_code: 'USD', unofficial_currency_code: null };
const options = { today, years: 2 };
function fixture() {
  return {
    items: [{ id: 'item', investment_ledger: { complete: true, start_date: '2024-09-07', end_date: today, holdings_sync_id: 'sync' }, transactions_history_complete: true }],
    accounts: [{ item_id: 'item', plaid_account_id: 'ira', type: 'investment', name: 'IRA', current_balance: 1200,
      investment_balance_anchor: { date: today, sync_id: 'sync', balance: 1200, ...usd } }],
    positions: [
      { account_id: 'ira', security_id: 'fund', type: 'etf', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, value: 1100, ...usd },
      { account_id: 'ira', security_id: 'cash', type: 'cash', price: 1, quantity: 100, value: 100, ...usd }
    ],
    investment_transactions: [
      { account_id: 'ira', date: '2026-09-01', type: 'cash', subtype: 'dividend', quantity: 0, amount: -10, ...usd },
      { account_id: 'ira', date: '2026-09-04', security_id: 'fund', type: 'buy', subtype: 'buy', quantity: 2, amount: 200, ...usd }
    ],
    market_prices: { VTI: { '2026-09-01': 100, '2026-09-07': 110 } },
    market_price_metadata: { VTI: { basis: 'unadjusted' } },
    investment_position_snapshots: [], investment_snapshots: [], snapshots: [], transactions: []
  };
}

test('long-held investments reconstruct before the first returned purchase, including cash', () => {
  const store = fixture();
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.state, 'ready');
  assert.equal(result.history[0].date, '2026-09-01');
  assert.equal(result.history[0].value, 1100); // eight old shares + $300 cash
  assert.equal(result.history.find((row) => row.date === '2026-09-04').value, 1100); // buy doesn't create wealth
  assert.equal(result.history.at(-1).value, 1200);
  assert.ok(result.history.every((row) => row.source === 'reconstructed'));
});

test('a sold holding contributes to earlier values and its proceeds remain cash', () => {
  const store = fixture();
  store.investment_transactions.push({ account_id: 'ira', date: '2026-09-03', security_id: 'sold', ticker: 'VXUS', provider_ticker: 'VXUS', security_type: 'etf', type: 'sell', subtype: 'sell', quantity: -4, amount: -200, ...usd });
  store.market_prices.VXUS = { '2026-09-01': 50 };
  store.market_price_metadata.VXUS = { basis: 'unadjusted' };
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.state, 'ready');
  assert.equal(result.history[0].value, 1100); // eight VTI + four VXUS + $100 cash
  assert.equal(result.history[2].value, 1100); // sale is not a loss
});

test('a separately reported dividend funds reinvestment without double-counting cash', () => {
  const store = fixture();
  store.investment_transactions[1] = { ...store.investment_transactions[1], subtype: 'dividend reinvestment' };
  store.investment_transactions.push({ account_id: 'ira', date: '2026-09-04', security_id: 'fund', quantity: 0, type: 'cash', subtype: 'dividend', amount: -200, ...usd });
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.history[0].value, 900);
  assert.equal(result.history.find((row) => row.date === '2026-09-04').value, 1100);
});

test('ambiguous reinvestment cannot invent its funding source', () => {
  const store = fixture();
  store.investment_transactions[1].subtype = 'dividend reinvestment';
  assert.equal(reconstructInvestmentAccount(store, store.accounts[0], options).history[0].date, '2026-09-04');
});

test('explicit combined contribution and purchase adds shares without invented cash history', () => {
  const store = fixture();
  store.investment_transactions[1] = { ...store.investment_transactions[1], type: 'cash', subtype: 'contribution' };
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.state, 'ready');
  assert.equal(result.history[0].value, 900);
  assert.equal(result.history.find((row) => row.date === '2026-09-04').value, 1100);
});

test('cash fees reduce value without altering share quantities or being added twice', () => {
  const store = fixture();
  store.investment_transactions.push({ account_id: 'ira', date: '2026-09-03', type: 'fee', subtype: 'miscellaneous fee', quantity: 0, amount: 5, fees: 5, ...usd });
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.history[0].value, 1105);
  assert.equal(result.history.find((row) => row.date === '2026-09-03').value, 1100);
});

test('corporate actions and ambiguous share transfers shorten history to their closing date', () => {
  for (const subtype of ['split', 'merger', 'transfer', 'contribution']) {
    const store = fixture();
    store.investment_transactions.push({ account_id: 'ira', date: '2026-09-03', type: 'transfer', subtype, quantity: 1, amount: 0, ...usd });
    assert.equal(reconstructInvestmentAccount(store, store.accounts[0], options).history[0].date, '2026-09-03');
  }
});

test('incomplete pages, mismatched anchors, currencies, unidentified funds and missing cash cannot create history', () => {
  const changes = [
    (s) => { s.items[0].investment_ledger.complete = false; },
    (s) => { s.items[0].investment_ledger.holdings_sync_id = 'older'; },
    (s) => { s.positions[0].iso_currency_code = 'CAD'; },
    (s) => { s.positions[0].provider_ticker = null; },
    (s) => { s.positions[0].type = 'derivative'; },
    (s) => { s.positions.pop(); },
    (s) => { s.positions[1].price = null; },
    (s) => { s.market_price_metadata = {}; },
    (s) => { s.investment_transactions[0].amount = null; },
    (s) => { s.investment_transactions[0].date = null; },
    (s) => { s.investment_transactions[0].date = '2026-02-30'; },
    (s) => { s.items[0].investment_ledger.start_date = null; }
  ];
  for (const change of changes) {
    const store = fixture(); change(store);
    assert.equal(reconstructInvestmentAccount(store, store.accounts[0], options).state, 'unavailable');
  }
});

test('stale prices truncate coverage instead of being carried forward indefinitely', () => {
  assert.equal(priceAt({ '2026-09-01': 100 }, '2026-09-08'), 100);
  assert.equal(priceAt({ '2026-08-01': 100 }, '2026-09-07'), null);
  const store = fixture();
  store.investment_transactions[0].date = '2026-08-01';
  store.market_prices.VTI = { '2026-08-01': 90, '2026-09-01': 100, '2026-09-07': 110 };
  assert.equal(reconstructInvestmentAccount(store, store.accounts[0], options).history[0].date, '2026-09-01');
});

test('earlier observed balances independently reject an otherwise matching current balance', () => {
  const store = fixture();
  store.investment_position_snapshots.push({ account_id: 'ira', kind: 'account', date: '2026-09-02', value: 500, source: 'verified' });
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.state, 'unavailable');
  assert.match(result.reason, /Earlier recorded balances/);
});

test('saved balances keep priority and their gaps; two updates no longer erase pre-link history', () => {
  const store = fixture();
  // The detail endpoint uses today's date, so use a cash-only fixture with
  // relative dates and no market clock dependence.
  const now = new Date().toISOString().slice(0, 10);
  const daysAgo = (days) => new Date(Date.parse(`${now}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  store.items[0].investment_ledger.end_date = now;
  store.accounts[0].investment_balance_anchor = { date: now, sync_id: 'sync', balance: 100, ...usd };
  store.accounts[0].current_balance = 100;
  store.positions = [store.positions[1]];
  store.investment_transactions = [{ account_id: 'ira', date: daysAgo(30), type: 'cash', subtype: 'deposit', quantity: 0, amount: -100, ...usd }];
  store.investment_position_snapshots = [7, 0].map((days) => ({ account_id: 'ira', kind: 'account', date: daysAgo(days), value: 100, source: 'verified' }));
  const detail = investmentDetailHistory(store, { accountId: 'ira' });
  assert.equal(detail.state, 'ready');
  assert.equal(detail.reconstructed, true);
  assert.equal(detail.history[0].date, daysAgo(30));
  assert.equal(detail.history.some((row) => row.date === daysAgo(6)), false);
  assert.match(detail.detail, /estimated/);
  store.investment_snapshots = store.investment_position_snapshots.map(({ date, value, source }) => ({ date, value, source }));
  refreshReconstructedInvestmentSnapshots(store, now);
  assert.equal(store.investment_snapshots[0].date, daysAgo(30));
  assert.equal(store.investment_snapshots.at(-1).source, 'verified');
});

function bankFixture() {
  return { items: [{ id: 'bank', transactions_history_complete: true }],
    accounts: [{ plaid_account_id: 'checking', item_id: 'bank', type: 'depository', current_balance: 900,
      transaction_balance_anchor: { date: today, balance: 900, ...usd } },
    { plaid_account_id: 'card', item_id: 'bank', type: 'credit', current_balance: 200,
      transaction_balance_anchor: { date: today, balance: 200, ...usd } }],
    transactions: [
      { account_id: 'checking', date: '2026-09-01', amount: -1000, ...usd },
      { account_id: 'checking', date: '2026-09-04', amount: 100, bucket: 'transfer', excluded: true, ...usd },
      { account_id: 'card', date: '2026-09-01', amount: 300, ...usd },
      { account_id: 'card', date: '2026-09-04', amount: -100, bucket: 'transfer', ...usd },
      { account_id: 'card', date: '2026-09-06', amount: 50, pending: true, ...usd }
    ], snapshots: [] };
}

test('net worth reverses cash and credit signs, includes excluded transfers, and ignores pending charges', () => {
  const store = bankFixture();
  const checking = reconstructCashAccount(store, store.accounts[0], options);
  const credit = reconstructCashAccount(store, store.accounts[1], options);
  assert.equal(checking.history[0].value, 1000);
  assert.equal(credit.history[0].value, 300);
  const history = reconstructedNetWorth(store, options);
  assert.equal(history[0].net_worth, 700);
  assert.equal(history.at(-1).net_worth, 700); // paying a card doesn't change net worth
  assert.equal(history[0].assets, 1000);
  assert.equal(history.at(-1).liabilities, 200);
});

test('net worth needs every visible account and uses only their common dates', () => {
  const store = bankFixture();
  store.accounts.push({ type: 'loan', current_balance: 5000 });
  assert.deepEqual(reconstructedNetWorth(store, options), []);
  store.accounts[2].hidden = true;
  store.transactions.find((row) => row.account_id === 'card').date = '2026-09-02';
  assert.equal(reconstructedNetWorth(store, options)[0].date, '2026-09-02');
  store.items[0].transactions_history_complete = false;
  assert.deepEqual(reconstructedNetWorth(store, options), []);
});

test('24-month coverage uses the requested window and does not require a holding acquisition inside it', () => {
  const store = fixture();
  store.investment_transactions[0].date = '2024-09-07';
  for (let time = Date.parse('2024-09-07T00:00:00Z'); time < Date.parse('2026-09-01T00:00:00Z'); time += 86400000) {
    store.market_prices.VTI[new Date(time).toISOString().slice(0, 10)] = 100;
  }
  const result = reconstructInvestmentAccount(store, store.accounts[0], options);
  assert.equal(result.history[0].date, '2024-09-07');
  assert.equal(result.history.length, 731);
  assert.equal(reconstructInvestmentAccount(store, store.accounts[0], { ...options, years: 1 }).history[0].date, '2025-09-07');
  const bank = bankFixture();
  bank.transactions[0].date = '2024-09-07';
  bank.transactions[2].date = '2024-09-07';
  assert.equal(reconstructedNetWorth(bank, options)[0].date, '2024-09-07');
});

test('cash history rejects missing currency, unknown balances, stale anchors and checkpoint mismatches', () => {
  for (const mutate of [
    (s) => { s.transactions[0].iso_currency_code = null; },
    (s) => { s.accounts[0].transaction_balance_anchor.balance = null; },
    (s) => { s.accounts[0].transaction_balance_anchor.date = '2026-01-01'; },
    (s) => { s.account_balance_snapshots = [{ account_id: 'checking', date: '2026-09-02', value: 250, source: 'verified' }]; }
  ]) {
    const store = bankFixture(); mutate(store);
    assert.equal(reconstructCashAccount(store, store.accounts[0], options).state, 'unavailable');
  }
});

test('a mixed investment/cash/debt total never substitutes current balances for missing history', () => {
  const store = fixture(), bank = bankFixture();
  store.items.push(...bank.items); store.accounts.push(...bank.accounts); store.transactions = bank.transactions;
  const history = reconstructedNetWorth(store, options);
  assert.equal(history[0].net_worth, 1800);
  assert.equal(history.at(-1).net_worth, 1900);
  store.market_price_metadata = {};
  assert.deepEqual(reconstructedNetWorth(store, options), []);
});

test('empty or nonoverlapping histories cannot produce a partial total', () => {
  assert.deepEqual(combinedHistory([[], [{ date: today, value: 1 }]]), []);
  assert.deepEqual(mergeReportedHistory([{ date: today, value: 100 }], [{ date: today, value: 110 }]), [{ date: today, value: 110 }]);
});

test('investment pagination collects all pages and refuses duplicates or a changing count', async () => {
  const calls = [];
  const payload = await investmentLedgerPages({ access_token: 'test', options: { async_update: true } }, async (path, body) => {
    calls.push(body.options);
    return { total_investment_transactions: 2, investment_transactions: [{ investment_transaction_id: String(body.options.offset) }], securities: [] };
  });
  assert.equal(payload.investment_transactions.length, 2);
  assert.equal(calls[1].offset, 1);
  assert.equal(calls[1].async_update, false);
  await assert.rejects(investmentLedgerPages({}, async () => ({ total_investment_transactions: 2, investment_transactions: [{ investment_transaction_id: 'same' }] })), /overlapped/);
  await assert.rejects(investmentLedgerPages({}, async () => ({ total_investment_transactions: 2, investment_transactions: [] })), /incomplete/);
});

test('market prices explicitly request unadjusted closes for contemporaneous quantities', async (t) => {
  const oldToken = process.env.MARKETDATA_API_TOKEN;
  process.env.MARKETDATA_API_TOKEN = 'test-only';
  t.after(() => { if (oldToken === undefined) delete process.env.MARKETDATA_API_TOKEN; else process.env.MARKETDATA_API_TOKEN = oldToken; });
  let requested;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested = new URL(url);
    return { status: 200, json: async () => ({ s: 'ok', t: [1788872400], c: [100] }) };
  });
  await loadHistoricalPrices({ symbol: 'VTI', securityType: 'etf', from: '2026-09-01', to: today });
  assert.equal(requested.searchParams.get('adjustsplits'), 'false');
  assert.equal(requested.searchParams.get('adjustdividends'), 'false');
});
