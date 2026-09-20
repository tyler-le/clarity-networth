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
  DEV_MOCK_CONNECTIONS: process.env.DEV_MOCK_CONNECTIONS,
  FREEMIUM_ENABLED: process.env.FREEMIUM_ENABLED,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_PLUS_PRICE_ID: process.env.STRIPE_PLUS_PRICE_ID,
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL,
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
  const sessionKey = crypto.createHash('sha256').update(process.env.SESSION_SECRET || process.env.ENCRYPTION_KEY).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ email, name: 'Rate Limit', exp: Date.now() + 60_000 }), 'utf8'),
    cipher.final()
  ]);
  return `clarity_session=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function stripeSignature(payload, secret, timestamp) {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return { raw, header: `t=${timestamp},v1=${signature}` };
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
  const errorContract = await request(app).get('/customer-error.js');
  assert.equal(errorContract.status, 200);
  assert.match(errorContract.text, /rate_limited/);
  assert.match(errorContract.headers['cache-control'], /no-store/);
});

integrationTest('uses an encrypted, tamper-evident session cookie for financial API access', async () => {
  const email = 'private-member@example.test';
  const cookie = signedTestCookie(email);
  assert.doesNotMatch(cookie, /private-member|cHJpdmF0ZS1tZW1iZXI/i, 'the email must not be readable from the cookie');
  const authenticated = await request(app).get('/api/auth/me').set('Cookie', cookie);
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.body.user.email, email);

  const [, value] = cookie.split('=');
  const parts = value.split('.');
  parts[3] = `${parts[3].startsWith('A') ? 'B' : 'A'}${parts[3].slice(1)}`;
  const tampered = parts.join('.');
  const rejected = await request(app).get('/api/auth/me').set('Cookie', `clarity_session=${tampered}`);
  assert.equal(rejected.status, 401);
});

integrationTest('serves public legal, support, and dependency-aware health pages', async () => {
  for (const pathname of ['/privacy', '/terms', '/support']) {
    const response = await request(app).get(pathname);
    assert.equal(response.status, 200);
    assert.match(response.text, /Clarity/);
    assert.match(response.text, /app-icon\.svg/);
    assert.match(response.text, /legal-brand/);
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

integrationTest('serves all available cash-flow history through the same public range contract', async () => {
  const response = await request(app).get('/api/demo-preview?range=all');
  assert.equal(response.status, 200);
  assert.equal(response.body.spending.range, 'all');
  assert.ok(response.body.spending.startDate <= response.body.spending.endDate);
  assert.ok(response.body.spending.monthly.length > 12);
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
    ['delete', '/api/account'],
  ]) {
    const response = await request(app)[method](pathname).send({});
    assert.equal(response.status, 401, pathname);
    assert.equal(response.body.error, 'Sign in required.');
  }
});

integrationTest('serves an authenticated dashboard for an existing member session', async () => {
  const email = 'existing-member@example.com';
  const key = userStorageKey(email);
  writeStore({ items: [], accounts: [], transactions: [], snapshots: [] }, key);
  const response = await request(app).get('/api/dashboard').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.ok(response.body.summary);
  assert.deepEqual(response.body.user, { email, name: 'Rate Limit' });
  deleteStore(key);
});

integrationTest('repairs a miscategorized posted inbound credit before serving cash flow', async () => {
  const email = 'cash-flow-reconciliation@example.com';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  writeStore({
    items: [], accounts: [], snapshots: [],
    transactions: [
      { id: 'external-credit', plaid_transaction_id: 'external-credit', date: today, amount: -10_440.38, bucket: 'guilt_free', pfc_primary: 'GENERAL_MERCHANDISE', pfc_detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', merchant_name: 'Employer bonus', pending: false },
      { id: 'internal-transfer', plaid_transaction_id: 'internal-transfer', date: today, amount: -500, bucket: 'guilt_free', pfc_primary: 'TRANSFER_IN', pfc_detailed: 'TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS', pending: false },
      { id: 'brokerage-contribution', plaid_transaction_id: 'brokerage-contribution', date: today, amount: 8_000, bucket: 'investments', pending: false }
    ]
  }, key);
  const response = await request(app).get('/api/spending?range=1m').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.equal(response.body.income, 10_440.38);
  assert.equal(response.body.investments, 8_000);
  assert.equal(response.body.total, 8_000);
  assert.equal(response.body.transactions.some((row) => row.id === 'internal-transfer'), false);
  assert.equal(readStore(key).transactions.find((row) => row.id === 'external-credit').bucket, 'income');
  assert.equal(readStore(key).transactions.find((row) => row.id === 'external-credit').cash_flow_type, 'external_inflow');
  assert.equal(readStore(key).transactions.find((row) => row.id === 'internal-transfer').cash_flow_type, 'internal_transfer');
  deleteStore(key);
});

integrationTest('investment history uses observed daily snapshots and stays isolated by session', async () => {
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
  assert.equal(detail.body.history[0].date, ago(7));
  assert.equal(detail.body.reconstructed, false);
  assert.match(detail.body.detail, /verified daily update/);
  const portfolio = await request(app).get('/api/investments').set('Cookie', signedTestCookie(email));
  assert.ok(portfolio.body.snapshots.every((snapshot) => snapshot.source === 'verified'));
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
  const requestedStart = new Date(`${today}T12:00:00Z`);
  requestedStart.setUTCMonth(requestedStart.getUTCMonth() - 1);
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
    requestedStartDate: requestedStart.toISOString().slice(0, 10), startDate: earlier, endDate: today, startValue: 1_000, endValue: 1_100, valueChange: 100,
    marketChange: 100, marketChangePct: .1, changeKind: 'market'
  });
  assert.deepEqual(holding.body.holdingProgress['ira:vti'], holding.body.progress);
  const account = await request(app).get('/api/investments/history?account_id=ira&range=1m').set('Cookie', cookie);
  assert.equal(account.status, 200);
  assert.equal(account.body.progress.valueChange, 100);
  assert.equal(account.body.progress.marketChange, null);
  assert.equal(account.body.progress.changeKind, 'balance');
  assert.deepEqual(account.body.holdingProgress['ira:vti'], holding.body.progress);
  deleteStore(key);
});

integrationTest('connected account detail is isolated and reports only verified balance history', async () => {
  const email = 'account-history@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 10 * 86_400_000).toISOString().slice(0, 10);
  writeStore({
    items: [{ id: 'bank' }],
    accounts: [
      { id: 'cash', plaid_account_id: 'cash', item_id: 'bank', type: 'depository', subtype: 'checking', name: 'Checking', current_balance: 700, hidden: false },
      { id: 'card', plaid_account_id: 'card', item_id: 'bank', type: 'credit', subtype: 'credit card', name: 'Card', current_balance: 250, hidden: false }
    ],
    account_balance_snapshots: [
      { account_id: 'cash', date: earlier, value: 500, source: 'verified' },
      { account_id: 'cash', date: today, value: 700, source: 'verified' },
      { account_id: 'cash', date: today, value: 999, source: 'estimated' },
      { account_id: 'card', date: today, value: 250, source: 'verified' }
    ],
    transactions: [
      { id: 'deposit', account_id: 'cash', date: today, name: 'Deposit', amount: -200, pending: false },
      { id: 'pending', account_id: 'cash', date: today, name: 'Pending', amount: 50, pending: true }
    ]
  }, key);
  const response = await request(app).get('/api/accounts/history?account_id=cash&range=1m').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.equal(response.body.account.name, 'Checking');
  assert.deepEqual(response.body.history.map((row) => row.value), [500, 700]);
  assert.equal(response.body.progress.valueChange, 200);
  assert.deepEqual(response.body.activity.map((row) => row.name), ['Deposit']);
  const other = await request(app).get('/api/accounts/history?account_id=cash').set('Cookie', signedTestCookie('other-account-history@example.test'));
  assert.equal(other.status, 404);
  deleteStore(key);
});

integrationTest('portfolio and account performance reconcile from one verified daily snapshot window', async () => {
  const email = 'reconciled-investment-summary@example.test';
  const key = userStorageKey(email);
  const today = new Date().toISOString().slice(0, 10);
  const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
  writeStore({
    items: [{ id: 'reconciled-item' }],
    accounts: [
      { plaid_account_id: 'ira', item_id: 'reconciled-item', name: 'IRA', type: 'investment', current_balance: 1_100, hidden: false },
      { plaid_account_id: 'brokerage', item_id: 'reconciled-item', name: 'Brokerage', type: 'investment', current_balance: 1_900, hidden: false }
    ],
    positions: [], investment_transactions: [], transactions: [], snapshots: [],
    // A legacy aggregate can disagree with its historical account entries.
    // The response must prefer the complete account ledger, not mix sources.
    investment_snapshots: [
      { date: earlier, value: 3_400, source: 'verified' },
      { date: today, value: 3_900, source: 'verified' }
    ],
    investment_position_snapshots: [
      { date: earlier, kind: 'account', key: 'ira', account_id: 'ira', value: 1_000, source: 'verified' },
      { date: earlier, kind: 'account', key: 'brokerage', account_id: 'brokerage', value: 2_000, source: 'verified' },
      { date: today, kind: 'account', key: 'ira', account_id: 'ira', value: 1_100, source: 'verified' },
      { date: today, kind: 'account', key: 'brokerage', account_id: 'brokerage', value: 1_900, source: 'verified' }
    ]
  }, key);
  const response = await request(app).get('/api/investments?range=1m').set('Cookie', signedTestCookie(email));
  assert.equal(response.status, 200);
  assert.equal(response.body.progress.basis, 'account_snapshots');
  assert.equal(response.body.progress.valueChange, 0);
  assert.deepEqual(response.body.snapshots.map(({ date, value, basis }) => ({ date, value, basis })), [
    { date: earlier, value: 3_000, basis: 'account_snapshots' },
    { date: today, value: 3_000, basis: 'account_snapshots' }
  ]);
  const rowChange = response.body.accounts.reduce((sum, account) => sum + Number(account.rangeProgress.valueChange || 0), 0);
  assert.equal(rowChange, response.body.progress.valueChange);
  assert.deepEqual(response.body.accounts.map((account) => account.rangeProgress.startDate), [earlier, earlier]);
  assert.deepEqual(response.body.accounts.map((account) => account.rangeProgress.endDate), [today, today]);
  deleteStore(key);
});

integrationTest('net worth returns only observed daily snapshots', async () => {
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
  assert.equal(response.body.snapshots.length, 1);
  assert.equal(response.body.snapshots[0].source, 'verified');
  assert.equal(response.body.snapshots[0].net_worth, 500);
  // The dashboard persists only the observed current-day baseline.
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

integrationTest('categorizing a transaction updates every matching merchant activity without crossing users', async () => {
  const email = 'transaction-category@example.com';
  const key = userStorageKey(email);
  writeStore({ items: [], accounts: [], snapshots: [], transactions: [
    { id: 'latest', merchant_name: 'Zelle: Rent', name: 'Zelle: Rent', date: '2026-09-15', amount: 1500, bucket: 'guilt_free', pending: false },
    { id: 'prior', merchant_name: 'Zelle Rent', name: 'Zelle Rent', date: '2026-08-15', amount: 1500, bucket: 'guilt_free', pending: false },
    { id: 'future', merchant_name: 'Zelle Rent', name: 'Zelle Rent', date: '2026-10-15', amount: 1500, bucket: 'guilt_free', pending: false },
    { id: 'other-recipient', merchant_name: 'Zelle: Alex', name: 'Zelle: Alex', date: '2026-08-15', amount: 50, bucket: 'guilt_free', pending: false }
  ] }, key);
  const response = await request(app).patch('/api/transactions/latest/category').set('Cookie', signedTestCookie(email)).send({ category: 'housing_bills' });
  assert.equal(response.status, 200);
  assert.equal(response.body.updated, 3);
  assert.equal(response.body.matchedDuplicates, 2);
  const stored = readStore(key);
  assert.equal(stored.transactions.find((transaction) => transaction.id === 'prior').cash_flow_category, 'housing_bills');
  assert.equal(stored.transactions.find((transaction) => transaction.id === 'future').cash_flow_category, 'housing_bills');
  assert.equal(stored.transactions.find((transaction) => transaction.id === 'other-recipient').cash_flow_category, undefined);
  assert.deepEqual(stored.cash_flow_category_rules.map(({ id, merchant_key, flow, category_key }) => ({ id, merchant_key, flow, category_key })), [{
    id: 'outflow:rent', merchant_key: 'rent', flow: 'outflow', category_key: 'housing_bills'
  }]);
  const changed = await request(app).patch('/api/transactions/latest/category').set('Cookie', signedTestCookie(email)).send({ category: 'fees' });
  assert.equal(changed.status, 200);
  assert.equal(readStore(key).cash_flow_category_rules[0].category_key, 'fees');
  const forgotten = await request(app).delete('/api/transaction-category-rules/outflow%3Arent').set('Cookie', signedTestCookie(email));
  assert.equal(forgotten.status, 200);
  assert.deepEqual(readStore(key).cash_flow_category_rules, []);
  const otherEmail = 'other-transaction-category@example.com';
  const otherKey = userStorageKey(otherEmail);
  writeStore({ items: [], accounts: [], snapshots: [], transactions: [{ id: 'latest', merchant_name: 'Zelle Rent', name: 'Zelle Rent', date: '2026-09-15', amount: 1500, bucket: 'guilt_free', pending: false }] }, otherKey);
  const forbidden = await request(app).patch('/api/transactions/latest/category').set('Cookie', signedTestCookie(otherEmail)).send({ category: 'invalid' });
  assert.equal(forbidden.status, 400);
  assert.equal(readStore(otherKey).transactions[0].cash_flow_category, undefined);
  deleteStore(key);
  deleteStore(otherKey);
});

integrationTest('categorizing income uses the same canonical category contract and leaves refunds alone', async () => {
  const email = 'income-category@example.com';
  const key = userStorageKey(email);
  writeStore({ items: [], accounts: [], snapshots: [], transactions: [
    { id: 'payroll-current', merchant_name: 'Acme payroll', name: 'Acme payroll', date: '2026-09-15', amount: -2_000, bucket: 'income', pending: false },
    { id: 'payroll-other', merchant_name: 'Acme payroll', name: 'Acme payroll', date: '2026-10-15', amount: -2_000, bucket: 'income', pending: false },
    { id: 'refund', merchant_name: 'Acme payroll refund', name: 'Acme payroll refund', date: '2026-09-16', amount: -25, bucket: 'income', pfc_detailed: 'MERCHANT_REFUND', pending: false }
  ] }, key);
  const response = await request(app).patch('/api/transactions/payroll-current/category').set('Cookie', signedTestCookie(email)).send({ category: 'income_business' });
  assert.equal(response.status, 200);
  assert.equal(response.body.updated, 2);
  assert.equal(response.body.matchedDuplicates, 1);
  const stored = readStore(key);
  assert.equal(stored.transactions.find((transaction) => transaction.id === 'payroll-other').cash_flow_category, 'income_business');
  assert.equal(stored.transactions.find((transaction) => transaction.id === 'refund').cash_flow_category, undefined);
  assert.deepEqual(stored.cash_flow_category_rules.map(({ id, merchant_key, flow, category_key }) => ({ id, merchant_key, flow, category_key })), [{
    id: 'income:acme payroll', merchant_key: 'acme payroll', flow: 'income', category_key: 'income_business'
  }]);
  const rejected = await request(app).patch('/api/transactions/refund/category').set('Cookie', signedTestCookie(email)).send({ category: 'income_business' });
  assert.equal(rejected.status, 400);
  deleteStore(key);
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
      { date: '2026-08-01', amount: 3000, bucket: 'fixed' },
      { date: '2026-08-02', amount: 1000, bucket: 'guilt_free' },
      { date: '2026-08-03', amount: 500, bucket: 'investments' }
    ]
  }, key);
  const cookie = signedTestCookie(email);
  const current = await request(app).get('/api/retirement').set('Cookie', cookie);
  assert.equal(current.body.monthlyContributions, 500 / 12);
  assert.equal(current.body.contributionMonthsObserved, 1);
  const preview = await request(app).post('/api/retirement/preview').set('Cookie', cookie).send({ age: 30, retirement_age: 65, withdrawal_rate: 3.5, real_return: 5, trailing_months: 6 });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.trailingMonths, 6);
  assert.ok(preview.body.coast < current.body.coast);
  assert.ok(preview.body.projectedAtRetirement > current.body.projectedAtRetirement);
  assert.ok(preview.body.standard > current.body.standard);
  assert.equal(readStore(key).settings.fire.retirement_age, 60);
  const broadAssumptions = await request(app).post('/api/retirement/preview').set('Cookie', cookie).send({ age: 100, retirement_age: 100, withdrawal_rate: 20, real_return: 15 });
  assert.equal(broadAssumptions.status, 200);
  assert.equal(broadAssumptions.body.withdrawalRate, 20);
  assert.equal(broadAssumptions.body.realReturn, 15);
  const rejectedAssumptions = await request(app).post('/api/retirement/preview').set('Cookie', cookie).send({ withdrawal_rate: 20.1, real_return: 15.1 });
  assert.equal(rejectedAssumptions.status, 400);
  const rejectedHistoryWindow = await request(app).post('/api/retirement/preview').set('Cookie', cookie).send({ trailing_months: 2 });
  assert.equal(rejectedHistoryWindow.status, 400);
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
  const demoAccount = investments.body.accounts[0];
  const history = await request(app).get(`/api/investments/history?account_id=${encodeURIComponent(demoAccount.id)}`).set('Cookie', cookie);
  assert.equal(history.status, 200, 'signed-in demo investment detail must not attempt to overwrite real data');
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
  assert.equal(blocked.body.error_code, 'rate_limited');
  assert.equal(blocked.body.recovery, 'wait');
  assert.equal(blocked.body.retry_after_seconds, 15 * 60);
  assert.match(blocked.body.error, /Try again in 15 minutes/);
  assert.doesNotMatch(blocked.body.error, /Plaid|provider|secret/i);
});

integrationTest('staging mock connection is explicitly gated, seeded, and removable without Plaid', async (t) => {
  const previousMockSetting = process.env.DEV_MOCK_CONNECTIONS;
  process.env.DEV_MOCK_CONNECTIONS = 'true';
  t.after(() => {
    if (previousMockSetting === undefined) delete process.env.DEV_MOCK_CONNECTIONS;
    else process.env.DEV_MOCK_CONNECTIONS = previousMockSetting;
  });
  const email = 'development-mock@example.test';
  const key = userStorageKey(email);
  const cookie = signedTestCookie(email);

  const link = await request(app).post('/api/plaid/create_link_token').set('Cookie', cookie).send({});
  assert.equal(link.status, 200);
  assert.deepEqual(link.body, { development_mock: true });

  const connected = await request(app).post('/api/plaid/development_mock_connect').set('Cookie', cookie).send({});
  assert.equal(connected.status, 200);
  assert.equal(connected.body.development_mock, true);
  assert.equal(connected.body.already_linked, false);
  assert.equal(connected.body.item.institution_name, 'Clarity Test Bank');
  const stored = readStore(key);
  assert.equal(stored.items.length, 1);
  assert.equal(stored.items[0].development_mock, true);
  assert.equal(stored.items[0].access_token_enc, undefined);
  assert.equal(stored.accounts.length, 9);
  assert.ok(stored.accounts.every((account) => account.demo === false));
  assert.deepEqual(
    stored.accounts.map((account) => [account.name, account.type, account.subtype]).sort((a, b) => a[0].localeCompare(b[0])),
    [
      ['401(k)', 'investment', '401k'],
      ['Auto loan', 'loan', 'auto'],
      ['Brokerage', 'investment', 'brokerage'],
      ['Capital One Venture', 'credit', 'credit card'],
      ['Chase Sapphire Preferred', 'credit', 'credit card'],
      ['Checking', 'depository', 'checking'],
      ['High Yield Savings', 'depository', 'savings'],
      ['Rewards balance', 'other', 'other'],
      ['Roth IRA', 'investment', 'ira']
    ].sort((a, b) => a[0].localeCompare(b[0]))
  );
  assert.ok(stored.positions.length > 0);
  assert.ok(stored.transactions.length > 0);
  assert.ok(stored.snapshots.length > 0);
  // The development connection is a testing fixture, but it must behave like
  // a long-running linked member: ranges, charts, and drill-ins need daily
  // records from one coherent source rather than a single connection-day dot.
  assert.ok(stored.snapshots.length >= 365);
  const mockNonInvestmentIds = new Set(stored.accounts.filter((account) => account.type !== 'investment').map((account) => account.plaid_account_id));
  assert.ok(stored.account_balance_snapshots.length >= 365 * mockNonInvestmentIds.size);
  assert.ok(mockNonInvestmentIds.size >= 6);
  const mockInvestmentIds = new Set(stored.accounts.filter((account) => account.type === 'investment').map((account) => account.plaid_account_id));
  const accountSnapshotsByDate = new Map();
  for (const snapshot of stored.investment_position_snapshots) {
    if (snapshot.kind !== 'account' || !mockInvestmentIds.has(snapshot.account_id)) continue;
    if (!accountSnapshotsByDate.has(snapshot.date)) accountSnapshotsByDate.set(snapshot.date, new Set());
    accountSnapshotsByDate.get(snapshot.date).add(snapshot.account_id);
  }
  assert.ok(accountSnapshotsByDate.size >= 365);
  assert.ok([...accountSnapshotsByDate.values()].every((ids) => ids.size === mockInvestmentIds.size));

  const repeated = await request(app).post('/api/plaid/development_mock_connect').set('Cookie', cookie).send({});
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.already_linked, true);
  assert.equal(readStore(key).items.length, 1);

  const dashboard = await request(app).get('/api/dashboard').set('Cookie', cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.developmentTesting, true);
  assert.equal(dashboard.body.demoMode, false);
  assert.equal(dashboard.body.items[0].development_mock, true);
  assert.equal(dashboard.body.connectionHealth[0].state, 'healthy');

  const unlinked = await request(app).delete(`/api/items/${connected.body.item.id}`).set('Cookie', cookie);
  assert.equal(unlinked.status, 200);
  assert.equal(readStore(key).items.length, 0);
  assert.equal(readStore(key).accounts.length, 0);
  deleteStore(key);
});

integrationTest('freemium limits only current Free-plan institutions and an unlink frees a slot', async (t) => {
  const previousMockSetting = process.env.DEV_MOCK_CONNECTIONS;
  const previousFreemiumSetting = process.env.FREEMIUM_ENABLED;
  process.env.DEV_MOCK_CONNECTIONS = 'true';
  process.env.FREEMIUM_ENABLED = 'true';
  t.after(() => {
    if (previousMockSetting === undefined) delete process.env.DEV_MOCK_CONNECTIONS;
    else process.env.DEV_MOCK_CONNECTIONS = previousMockSetting;
    if (previousFreemiumSetting === undefined) delete process.env.FREEMIUM_ENABLED;
    else process.env.FREEMIUM_ENABLED = previousFreemiumSetting;
  });

  const email = 'freemium-current-institutions@example.test';
  const key = userStorageKey(email);
  const cookie = signedTestCookie(email);
  writeStore({
    items: [
      { id: 'first', institution_name: 'First Bank', development_mock: true, demo: false },
      { id: 'second', institution_name: 'Second Bank', development_mock: true, demo: false }
    ],
    accounts: [], positions: [], transactions: [], snapshots: [],
    settings: { membership: { plan: 'free' } }
  }, key);

  const dashboard = await request(app).get('/api/dashboard').set('Cookie', cookie);
  assert.equal(dashboard.status, 200);
  assert.deepEqual(
    {
      enabled: dashboard.body.entitlements.enabled,
      linkedInstitutionCount: dashboard.body.entitlements.linkedInstitutionCount,
      linkedInstitutionLimit: dashboard.body.entitlements.linkedInstitutionLimit,
      canConnectInstitution: dashboard.body.entitlements.canConnectInstitution
    },
    { enabled: true, linkedInstitutionCount: 2, linkedInstitutionLimit: 2, canConnectInstitution: false }
  );

  // Block before opening Link so a member cannot spend a provider attempt on
  // a connection the plan will not allow.
  const blocked = await request(app).post('/api/plaid/create_link_token').set('Cookie', cookie).send({});
  assert.equal(blocked.status, 403);
  assert.deepEqual(blocked.body, {
    error: 'Your Free plan includes two connected institutions. Unlink one to connect another.',
    error_code: 'institution_limit_reached',
    recovery: 'manage_connections'
  });

  const unlinked = await request(app).delete('/api/items/first').set('Cookie', cookie);
  assert.equal(unlinked.status, 200);
  assert.equal(readStore(key).items.length, 1);

  const availableAgain = await request(app).post('/api/plaid/create_link_token').set('Cookie', cookie).send({});
  assert.equal(availableAgain.status, 200);
  assert.deepEqual(availableAgain.body, { development_mock: true });
  deleteStore(key);
});

integrationTest('configured billing keeps Free core data open and exposes Plus entitlements', async (t) => {
  const previous = {
    freemium: process.env.FREEMIUM_ENABLED,
    secret: process.env.STRIPE_SECRET_KEY,
    webhook: process.env.STRIPE_WEBHOOK_SECRET,
    price: process.env.STRIPE_PLUS_PRICE_ID,
    appUrl: process.env.PUBLIC_APP_URL
  };
  process.env.FREEMIUM_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'rk_test_integration';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_integration';
  process.env.STRIPE_PLUS_PRICE_ID = 'price_integration';
  process.env.PUBLIC_APP_URL = 'https://clarity.example.test';
  t.after(() => {
    for (const [key, value] of Object.entries({
      FREEMIUM_ENABLED: previous.freemium,
      STRIPE_SECRET_KEY: previous.secret,
      STRIPE_WEBHOOK_SECRET: previous.webhook,
      STRIPE_PLUS_PRICE_ID: previous.price,
      PUBLIC_APP_URL: previous.appUrl
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const email = 'subscription-gate@example.test';
  const key = userStorageKey(email);
  const cookie = signedTestCookie(email);
  writeStore({ items: [], accounts: [], transactions: [], snapshots: [], settings: { membership: { plan: 'free' } } }, key);

  const dashboard = await request(app).get('/api/dashboard').set('Cookie', cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.subscriptionRequired, undefined);
  assert.equal(dashboard.body.entitlements.requiresSubscription, false);
  assert.equal(dashboard.body.entitlements.billingAvailable, true);

  const spending = await request(app).get('/api/spending?range=1m').set('Cookie', cookie);
  assert.equal(spending.status, 200);
  assert.equal(spending.body.range, '1m');
  deleteStore(key);
});

integrationTest('a signed Stripe subscription webhook updates only its member entitlement', async (t) => {
  const previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_integration_test';
  t.after(() => {
    if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
  });
  const email = 'stripe-member@example.test';
  const key = userStorageKey(email);
  writeStore({ items: [], accounts: [], settings: { membership: { plan: 'free' } } }, key);
  const created = Math.floor(Date.now() / 1000);
  const payload = {
    id: 'evt_subscription_updated', created, type: 'customer.subscription.updated',
    data: { object: {
      id: 'sub_123456', customer: 'cus_123456', status: 'active', current_period_end: created + 2_592_000,
      metadata: { user_key: key }
    } }
  };
  const signed = stripeSignature(payload, process.env.STRIPE_WEBHOOK_SECRET, created);
  const response = await request(app).post('/api/billing/stripe/webhook')
    .set('Stripe-Signature', signed.header).set('Content-Type', 'application/json').send(signed.raw);
  assert.equal(response.status, 200);
  assert.deepEqual(readStore(key).settings.membership, {
    plan: 'plus', trial_ends_at: null, subscription_status: 'active',
    subscription_ends_at: new Date((created + 2_592_000) * 1000).toISOString(),
    stripe_customer_id: 'cus_123456', stripe_subscription_id: 'sub_123456', stripe_event_created_at: created
  });
  deleteStore(key);
});

integrationTest('development mock connection cannot be reached from a production host', async (t) => {
  const previousMockSetting = process.env.DEV_MOCK_CONNECTIONS;
  process.env.DEV_MOCK_CONNECTIONS = 'true';
  t.after(() => {
    if (previousMockSetting === undefined) delete process.env.DEV_MOCK_CONNECTIONS;
    else process.env.DEV_MOCK_CONNECTIONS = previousMockSetting;
  });
  const response = await request(app)
    .post('/api/plaid/development_mock_connect')
    .set('Host', 'claritynetworth.com')
    .set('Cookie', signedTestCookie('production-host@example.test'))
    .send({});
  assert.equal(response.status, 404);
});

integrationTest('Railway staging uses the development app icon without trusting the request host', async (t) => {
  const previousEnvironment = process.env.RAILWAY_ENVIRONMENT_NAME;
  process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
  t.after(() => {
    if (previousEnvironment === undefined) delete process.env.RAILWAY_ENVIRONMENT_NAME;
    else process.env.RAILWAY_ENVIRONMENT_NAME = previousEnvironment;
  });
  const icon = await request(app).get('/app-icon.svg').set('Host', 'claritynetworth.com');
  const manifest = await request(app).get('/manifest.webmanifest').set('Host', 'claritynetworth.com');
  assert.equal(icon.status, 200);
  assert.match(icon.body.toString('utf8'), /#123b2a/);
  assert.equal(manifest.body.name, 'Clarity Dev');
});

integrationTest('does not create a Plaid reconnect session for another or missing connection', async () => {
  const response = await request(app)
    .post('/api/items/not-a-real-item/create_reconnect_token')
    .set('Cookie', signedTestCookie('reconnect@example.com'))
    .send({});
  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'Connection not found.');
});
