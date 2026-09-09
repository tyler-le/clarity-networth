import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-http-test-'));
const previousEnvironment = {
  CLARITY_LISTEN: process.env.CLARITY_LISTEN,
  DATA_DIR: process.env.DATA_DIR,
  NODE_ENV: process.env.NODE_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
  PLAID_SECRET: process.env.PLAID_SECRET,
  PLAID_ENV: process.env.PLAID_ENV,
  INVITE_CODE: process.env.INVITE_CODE,
  DOTENV_CONFIG_PATH: process.env.DOTENV_CONFIG_PATH
};

process.env.CLARITY_LISTEN = 'false';
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'false';
process.env.ENCRYPTION_KEY = 'integration-test-encryption-key';
// dotenv loads the developer's real configuration before this test module.
// Integration tests must never use those provider credentials: doing so both
// breaks local/CI parity and risks a billable request during verification.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.PLAID_CLIENT_ID;
delete process.env.PLAID_SECRET;
delete process.env.PLAID_ENV;
delete process.env.INVITE_CODE;
// server.js imports dotenv/config. Point it at an empty test-only path so it
// cannot load the repository's developer .env after the credentials above
// have been removed.
process.env.DOTENV_CONFIG_PATH = path.join(dataDir, 'no-provider-credentials.env');
const { app } = await import(`../../src/server.js?integration=${Date.now()}`);
const { deleteStore, readStore, userStorageKey, writeStore } = await import('../../src/lib/store.js');
const { decryptPayload } = await import('../../src/lib/secure-payload.js');
const integrationTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED ? test.skip : test;

function signedTestCookie(email = 'rate-limit@example.com') {
  const payload = Buffer.from(JSON.stringify({ email, name: 'Rate Limit', exp: Date.now() + 60_000 })).toString('base64url');
  const secret = crypto.createHash('sha256').update(process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY).digest();
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `clarity_session=${payload}.${signature}`;
}

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

integrationTest('serves the app shell with defensive browser headers', async () => {
  const response = await request(app).get('/');
  assert.equal(response.status, 200);
  assert.match(response.text, /Explore the demo/);
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['permissions-policy'], /camera=\(\)/);

  const runtimeApp = await request(app).get('/runtime/app.js');
  assert.equal(runtimeApp.status, 200);
  assert.match(runtimeApp.text, /retirement-milestone/);
  assert.match(runtimeApp.headers['cache-control'], /no-store/);
});

integrationTest('serves public legal, support, and dependency-aware health pages', async () => {
  for (const pathname of ['/privacy', '/terms', '/support']) {
    const response = await request(app).get(pathname);
    assert.equal(response.status, 200);
    assert.match(response.text, /Clarity/);
  }
  const privacy = await request(app).get('/privacy');
  assert.match(privacy.text, /aggregate daily count/i);
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, securityReady: true, databaseReady: true });
});

integrationTest('keeps a bounded encrypted recovery snapshot and removes it on deletion', () => {
  const key = 'a'.repeat(64);
  writeStore({ items: [{ id: 'before' }], accounts: [{ id: 'before' }], transactions: [] }, key);
  writeStore({ items: [], accounts: [], transactions: [] }, key);
  const backup = path.join(dataDir, 'backups', key, `${new Date().toISOString().slice(0, 10)}.json`);
  assert.equal(fs.existsSync(backup), true);
  const stored = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.match(stored.payload_enc, /^v1\./);
  assert.equal(JSON.parse(decryptPayload(stored.payload_enc)).accounts[0].id, 'before');
  deleteStore(key);
  assert.equal(fs.existsSync(path.join(dataDir, 'backups', key)), false);
});

integrationTest('serves a complete public demo without a session', async () => {
  const response = await request(app).get('/api/demo-preview?range=1y');
  assert.equal(response.status, 200);
  assert.equal(response.body.dashboard.demoMode, true);
  assert.deepEqual(response.body.dashboard.items.map((item) => item.institution_name), ['Chase', 'Ally', 'Fidelity', 'Capital One']);
  assert.ok(response.body.dashboard.items.every((item) => item.demo));
  assert.ok(response.body.dashboard.snapshots.length >= 84);
  assert.equal(response.body.spending.range, '1y');
  assert.equal(response.body.spending.monthly.length, 12);
  assert.ok(response.body.spending.monthly.every((month) => month.income > 0 && month.amount > 0));
  assert.ok(response.body.investments.positionsAvailable);
  assert.ok(response.body.retirement.standard > 0);
  assert.ok(response.body.retirement.projectedAtRetirement > 0);
  assert.equal(response.body.dashboard.debtPayoff.strategy, 'avalanche');
  assert.equal(response.body.dashboard.debtPayoff.priority.name, 'Chase Sapphire Preferred');
  const holdingHistory = await request(app).get('/api/demo-investments/history?ticker=VTI');
  assert.equal(holdingHistory.status, 200);
  assert.equal(holdingHistory.body.state, 'ready');
  assert.ok(holdingHistory.body.history.length > 100);
  assert.deepEqual(holdingHistory.body.market, []);
});

integrationTest('falls back safely for unsupported public-demo timeframes', async () => {
  const response = await request(app).get('/api/demo-preview?range=all-time');
  assert.equal(response.status, 200);
  assert.equal(response.body.spending.range, '1m');
  assert.equal(response.body.spending.monthly.length, 1);
});

integrationTest('protects personal financial endpoints without a session', async () => {
  for (const [method, pathname] of [
    ['get', '/api/dashboard'],
    ['get', '/api/spending?range=1y'],
    ['get', '/api/investments'],
    ['post', '/api/investment-accounts/example/manual-holdings'],
    ['patch', '/api/manual-holdings/example/asset-class'],
    ['delete', '/api/manual-holdings/example'],
    ['get', '/api/retirement'],
    ['get', '/api/data-export'],
    ['post', '/api/launch-event'],
    ['delete', '/api/account'],
  ]) {
    const response = await request(app)[method](pathname).send({});
    assert.equal(response.status, 401, pathname);
    assert.equal(response.body.error, 'Sign in required.');
  }
});

integrationTest('accepts only minimal allowlisted launch telemetry', async () => {
  const cookie = signedTestCookie('launch-event@example.com');
  const valid = await request(app).post('/api/launch-event').set('Cookie', cookie).send({ event: 'retirement_outlook_viewed' });
  assert.equal(valid.status, 204);
  const invalid = await request(app).post('/api/launch-event').set('Cookie', cookie).send({ event: 'screen_recording_or_balance' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'Invalid launch event.');
});

integrationTest('serves an authenticated dashboard for an existing member session', async () => {
  const email = 'existing-member@example.com';
  const key = userStorageKey(email);
  writeStore({ items: [], accounts: [], transactions: [], snapshots: [] }, key);
  const response = await request(app).get('/api/dashboard').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.ok(response.body.summary);
  deleteStore(key);
});

integrationTest('pre-link investment history survives saved updates and stays isolated by session', async () => {
  const email = 'history-owner@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  const ago = (days) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  writeStore({
    items: [{ id: 'history-item', investment_ledger: { complete: true, start_date: ago(730), end_date: today, holdings_sync_id: 'sync' } }],
    accounts: [{ id: 'ira', plaid_account_id: 'ira', item_id: 'history-item', name: 'IRA', type: 'investment', current_balance: 100,
      investment_balance_anchor: { date: today, sync_id: 'sync', balance: 100, iso_currency_code: 'USD' } }],
    positions: [{ account_id: 'ira', security_id: 'cash', type: 'cash', quantity: 100, price: 1, value: 100, iso_currency_code: 'USD' }],
    investment_transactions: [{ account_id: 'ira', date: ago(100), type: 'cash', subtype: 'deposit', quantity: 0, amount: -100, iso_currency_code: 'USD' }],
    investment_position_snapshots: [7, 0].map((days) => ({ date: ago(days), account_id: 'ira', kind: 'account', value: 100, source: 'verified' })),
    investment_snapshots: [7, 0].map((days) => ({ date: ago(days), value: 100, source: 'verified' })),
    transactions: [], snapshots: []
  }, key);
  const detail = await request(app).get('/api/investments/history?account_id=ira').set('Cookie', signedTestCookie(email));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.history[0].date, ago(100));
  assert.equal(detail.body.reconstructed, true);
  assert.match(detail.body.detail, /estimated/);
  assert.equal(detail.body.history.some((row) => row.date === ago(6)), false);
  const portfolio = await request(app).get('/api/investments').set('Cookie', signedTestCookie(email));
  assert.equal(portfolio.body.snapshots[0].source, 'reconstructed');
  assert.equal(portfolio.body.snapshots.at(-1).source, 'verified');
  const other = await request(app).get('/api/investments/history?account_id=ira').set('Cookie', signedTestCookie('other-history@example.test'));
  assert.deepEqual(other.body.history, []);
});

integrationTest('opening a holding begins a verified daily-snapshot trend when no older ledger can be reconstructed', async () => {
  const email = 'holding-snapshot@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  writeStore({
    items: [{ id: 'snapshot-item' }],
    accounts: [{ plaid_account_id: 'hsa', item_id: 'snapshot-item', name: 'HSA', type: 'investment', current_balance: 1_250, hidden: false }],
    positions: [{ id: 'hsa:vti', account_id: 'hsa', security_id: 'vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', value: 1_250 }],
    investment_transactions: [], investment_position_snapshots: [], transactions: [], snapshots: []
  }, key);
  const detail = await request(app).get('/api/investments/history?ticker=VTI').set('Cookie', signedTestCookie(email));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.state, 'tracking');
  assert.deepEqual(detail.body.history, [{ date: today, value: 1_250 }]);
  deleteStore(key);
});

integrationTest('investment history exposes range-safe verified progress without calling deposits performance', async () => {
  const email = 'verified-investment-progress@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86400000).toISOString().slice(0, 10);
  writeStore({
    items: [{ id: 'progress-item' }],
    accounts: [{ plaid_account_id: 'ira', item_id: 'progress-item', name: 'IRA', type: 'investment', current_balance: 1_100, iso_currency_code: 'USD', hidden: false }],
    positions: [{ id: 'ira:vti', account_id: 'ira', security_id: 'security-vti', ticker: 'VTI', provider_ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', quantity: 10, price: 110, value: 1_100, iso_currency_code: 'USD' }],
    investment_transactions: [], transactions: [], snapshots: [],
    investment_position_snapshots: [
      { date: earlier, kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'security-vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 100, value: 1_000, source: 'verified' },
      { date: today, kind: 'holding', key: 'ira:vti', account_id: 'ira', security_id: 'security-vti', ticker: 'VTI', provider_ticker: 'VTI', quantity: 10, price: 110, value: 1_100, source: 'verified' },
      { date: earlier, kind: 'account', key: 'ira', account_id: 'ira', value: 1_000, source: 'verified' },
      { date: today, kind: 'account', key: 'ira', account_id: 'ira', value: 1_100, source: 'verified' }
    ]
  }, key);
  const cookie = signedTestCookie(email);
  const holding = await request(app).get('/api/investments/history?ticker=VTI&range=1m').set('Cookie', cookie);
  assert.equal(holding.status, 200);
  assert.deepEqual(holding.body.progress, {
    scope: 'holding', range: '1m', state: 'ready', points: 2,
    startDate: earlier, endDate: today, startValue: 1_000, endValue: 1_100, valueChange: 100,
    marketChange: 100, marketChangePct: .1, trend: [1_000, 1_100], changeKind: 'market'
  });
  const account = await request(app).get('/api/investments/history?account_id=ira&range=1m').set('Cookie', cookie);
  assert.equal(account.status, 200);
  assert.equal(account.body.progress.valueChange, 100);
  assert.equal(account.body.progress.marketChange, null);
  assert.equal(account.body.progress.changeKind, 'balance');
  deleteStore(key);
});

integrationTest('net worth returns reconstructed history only when all visible accounts have coverage', async () => {
  const email = 'cash-history@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 100 * 86400000).toISOString().slice(0, 10);
  writeStore({ items: [{ id: 'bank', transactions_history_complete: true }],
    accounts: [{ id: 'cash', plaid_account_id: 'cash', item_id: 'bank', type: 'depository', name: 'Checking', current_balance: 500,
      transaction_balance_anchor: { date: today, balance: 500, iso_currency_code: 'USD' } }],
    transactions: [{ account_id: 'cash', date: earlier, amount: -500, iso_currency_code: 'USD' }], snapshots: []
  }, key);
  const response = await request(app).get('/api/dashboard').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.equal(response.body.snapshots[0].date, earlier);
  assert.equal(response.body.snapshots[0].source, 'reconstructed');
  assert.equal(response.body.snapshots[0].net_worth, 500);
  assert.equal(response.body.snapshots.at(-1).source, 'verified');
  // Derived values are recalculated; they never become saved provider facts.
  const stored = readStore(key);
  assert.ok(stored.snapshots.every((row) => row.source === 'verified'));
  stored.accounts.push({ id: 'loan', type: 'loan', current_balance: 1000, name: 'Loan' });
  writeStore(stored, key);
  const incomplete = await request(app).get('/api/dashboard').set('Cookie', signedTestCookie(email));
  assert.ok(incomplete.body.snapshots.every((row) => row.source === 'verified'));
});

integrationTest('link sync retains complete ledger evidence and removes canceled investment activity across pages', async (t) => {
  const oldId = process.env.PLAID_CLIENT_ID, oldSecret = process.env.PLAID_SECRET;
  process.env.PLAID_CLIENT_ID = 'test-only'; process.env.PLAID_SECRET = 'test-only';
  t.after(() => {
    if (oldId === undefined) delete process.env.PLAID_CLIENT_ID; else process.env.PLAID_CLIENT_ID = oldId;
    if (oldSecret === undefined) delete process.env.PLAID_SECRET; else process.env.PLAID_SECRET = oldSecret;
  });
  const today = new Date().toISOString().slice(0, 10);
  const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  const accounts = [
    { account_id: 'linked-cash', name: 'Checking', type: 'depository', balances: { current: 500, iso_currency_code: 'USD' } },
    { account_id: 'linked-ira', name: 'IRA', subtype: 'ira', type: 'investment', balances: { current: 100, iso_currency_code: 'USD' } }
  ];
  const investment = { account_id: 'linked-ira', date: earlier, name: 'IRA contribution', type: 'cash', subtype: 'contribution', quantity: 0, amount: -100, iso_currency_code: 'USD' };
  const rows = [{ ...investment, investment_transaction_id: 'canceled' }, { ...investment, investment_transaction_id: 'cancellation', cancel_transaction_id: 'canceled' }, { ...investment, investment_transaction_id: 'valid' }];
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(init.body);
    let data;
    if (pathname === '/item/public_token/exchange') data = { item_id: 'test-item', access_token: 'test-access' };
    else if (pathname === '/institutions/search') data = { institutions: [] };
    else if (pathname === '/accounts/get') data = { accounts };
    else if (pathname === '/investments/holdings/get') data = { accounts, securities: [{ security_id: 'cash-security', type: 'cash', iso_currency_code: 'USD' }], holdings: [{ account_id: 'linked-ira', security_id: 'cash-security', quantity: 100, institution_price: 1, institution_value: 100, iso_currency_code: 'USD' }] };
    else if (pathname === '/transactions/sync') data = { accounts, added: [{ transaction_id: 'deposit', account_id: 'linked-cash', date: earlier, amount: -500, iso_currency_code: 'USD' }], modified: [], removed: [], has_more: false, next_cursor: 'complete-cursor', transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' };
    else if (pathname === '/investments/transactions/get') { pages += 1; data = { total_investment_transactions: 3, investment_transactions: [rows[body.options.offset]], securities: [] }; }
    else throw new Error(`Unexpected test dependency: ${pathname}`);
    return { ok: true, status: 200, json: async () => data };
  });
  const email = 'linked-history@example.test';
  const response = await request(app).post('/api/plaid/exchange_public_token').set('Cookie', signedTestCookie(email)).send({ public_token: 'test-public', institution_name: 'Test Bank' });
  assert.equal(response.status, 200);
  assert.equal(pages, 3);
  const stored = readStore(userStorageKey(email));
  assert.deepEqual(stored.investment_transactions.map((row) => row.id), ['valid']);
  assert.equal(stored.items[0].investment_ledger.complete, true);
  assert.equal(stored.items[0].transactions_history_complete, true);
  assert.equal(stored.accounts[0].transaction_balance_anchor.balance, 500);
  assert.equal(stored.transactions.filter((row) => row.source === 'investment_transaction').length, 1);
});

integrationTest('does not expose sign-in configuration secrets', async () => {
  const response = await request(app).get('/api/auth/config');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['configured', 'googleClientId']);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.googleClientId, null);
});

integrationTest('checks an invite code before beginning Google sign-in without creating a session', async () => {
  const response = await request(app).post('/api/auth/access-code').send({ inviteCode: 'not-a-real-code' });
  assert.equal(response.status, 503);
  assert.equal(response.headers['set-cookie'], undefined);
});

integrationTest('previews a retirement plan without changing the saved assumptions', async () => {
  const email = 'retirement-preview@example.com';
  const key = userStorageKey(email);
  writeStore({
    settings: { fire: { age: 30, retirement_age: 60, withdrawal_rate: 4, real_return: 5 } },
    accounts: [{ id: 'investment', type: 'investment', current_balance: 100000 }],
    items: [], snapshots: [],
    transactions: [
      { date: '2026-09-01', amount: 3000, bucket: 'fixed' },
      { date: '2026-09-02', amount: 1000, bucket: 'guilt_free' },
      { date: '2026-09-03', amount: 500, bucket: 'investments' }
    ]
  }, key);
  const cookie = signedTestCookie(email);
  const current = await request(app).get('/api/retirement').set('Cookie', cookie);
  const preview = await request(app).post('/api/retirement/preview').set('Cookie', cookie).send({ age: 30, retirement_age: 65, withdrawal_rate: 3.5, real_return: 5 });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.coast < current.body.coast);
  assert.ok(preview.body.projectedAtRetirement > current.body.projectedAtRetirement);
  assert.ok(preview.body.standard > current.body.standard);
  assert.equal(readStore(key).settings.fire.retirement_age, 60);
  deleteStore(key);
});

integrationTest('signed-in demo mode uses its own consistent retirement scenario', async () => {
  const email = 'demo-boundary@example.com';
  const key = userStorageKey(email);
  writeStore({
    settings: { fire: { age: 42, retirement_age: 48, withdrawal_rate: 3, real_return: 1 } },
    accounts: [{ id: 'personal-investment', plaid_account_id: 'personal-investment', name: 'Private brokerage', type: 'investment', current_balance: 5000 }],
    items: [], snapshots: [], transactions: [{ id: 'private-transaction', merchant_name: 'Private employer bonus', name: 'Private employer bonus', date: '2026-09-01', amount: -5000, bucket: 'income' }]
  }, key);
  const cookie = signedTestCookie(email);
  const enable = await request(app).post('/api/demo-mode').set('Cookie', cookie).send({ enabled: true });
  assert.equal(enable.status, 200);
  const beforeDemoReads = readStore(key);
  const dashboard = await request(app).get('/api/dashboard').set('Cookie', cookie);
  const spending = await request(app).get('/api/spending?range=1y').set('Cookie', cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(spending.status, 200);
  assert.equal(JSON.stringify(dashboard.body).includes('Private brokerage'), false, 'dashboard must not expose a real account');
  assert.equal(JSON.stringify(spending.body).includes('Private employer bonus'), false, 'cash flow must not expose a real transaction');
  const retirement = await request(app).get('/api/retirement').set('Cookie', cookie);
  assert.equal(retirement.status, 200);
  assert.equal(retirement.body.age, 27, 'demo must not inherit a member’s age');
  assert.equal(retirement.body.retirementAge, 65, 'demo must not inherit a member’s retirement target');
  assert.equal(retirement.body.realReturn, 5, 'demo must not inherit a member’s return assumption');
  // Demo spending can evolve as its representative scenario improves (for
  // example, adding realistic subscriptions). Its assumptions must remain
  // isolated and its resulting Coast estimate must remain usable—not a fixed
  // implementation-specific month count.
  assert.ok(Number.isFinite(retirement.body.ladder.find((step) => step.key === 'coast').estimatedMonths));
  const investments = await request(app).get('/api/investments').set('Cookie', cookie);
  assert.equal(investments.status, 200, 'signed-in demo must load investment data without saving its seeded view');
  assert.deepEqual([...new Set(investments.body.positions.map((position) => position.ticker))].sort(), ['BND', 'SPAXX', 'VTI', 'VXUS'], 'demo should teach a simple three-fund portfolio with a small cash position');
  const demoAccount = investments.body.accounts[0];
  const history = await request(app).get(`/api/investments/history?account_id=${encodeURIComponent(demoAccount.id)}`).set('Cookie', cookie);
  assert.equal(history.status, 200, 'signed-in demo investment detail must not attempt to overwrite real data');
  assert.ok(history.body.history.length >= 2, 'demo investment accounts should have long-running verified history');
  const changeDebt = await request(app).patch('/api/settings/debt-strategy').set('Cookie', cookie).send({ strategy: 'snowball' });
  const createGoal = await request(app).post('/api/goals').set('Cookie', cookie).send({ name: 'Should not persist', source: 'cash', target: 1000 });
  assert.equal(changeDebt.status, 409, 'demo must reject real settings changes');
  assert.equal(createGoal.status, 409, 'demo must reject real goal changes');
  const afterDemoReads = readStore(key);
  assert.deepEqual(afterDemoReads.accounts, beforeDemoReads.accounts, 'demo reads must leave real accounts untouched');
  assert.deepEqual(afterDemoReads.transactions, beforeDemoReads.transactions, 'demo reads must leave real transactions untouched');
  assert.deepEqual(afterDemoReads.snapshots, beforeDemoReads.snapshots, 'demo reads must not create real snapshots');
  deleteStore(key);
});

integrationTest('rejects unsigned Plaid webhooks before processing financial data', async () => {
  const response = await request(app).post('/api/plaid/webhook').send({ item_id: 'untrusted-item' });
  assert.equal(response.status, 401);
});

integrationTest('caps cost-sensitive Plaid link-token attempts before provider calls', async () => {
  const cookie = signedTestCookie();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await request(app).post('/api/plaid/create_link_token').set('Cookie', cookie).send({});
    // Plaid itself is deliberately unconfigured in tests; reaching this point
    // proves the first attempts pass only the local cost gate.
    assert.equal(response.status, 500);
  }
  const blocked = await request(app).post('/api/plaid/create_link_token').set('Cookie', cookie).send({});
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.error, /Too many account-connection attempts/);
});

integrationTest('does not create a Plaid reconnect session for another or missing connection', async () => {
  const response = await request(app)
    .post('/api/items/not-a-real-item/create_reconnect_token')
    .set('Cookie', signedTestCookie('reconnect@example.com'))
    .send({});
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'Connection not found.');
});
