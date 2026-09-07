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
const { app } = await import(`../../server.js?integration=${Date.now()}`);
const { deleteStore, readStore, userStorageKey, writeStore } = await import('../../store.js');
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
  const health = await request(app).get('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true, securityReady: true, databaseReady: true });
});

integrationTest('keeps a bounded encrypted recovery snapshot and removes it on deletion', () => {
  const key = 'a'.repeat(64);
  writeStore({ items: [], accounts: [], transactions: [] }, key);
  const backup = path.join(dataDir, 'backups', key, `${new Date().toISOString().slice(0, 10)}.json`);
  assert.equal(fs.existsSync(backup), true);
  const stored = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.match(stored.payload_enc, /^v1\./);
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
    ['delete', '/api/account'],
  ]) {
    const response = await request(app)[method](pathname).send({});
    assert.equal(response.status, 401, pathname);
    assert.equal(response.body.error, 'Sign in required.');
  }
});

integrationTest('does not expose sign-in configuration secrets', async () => {
  const response = await request(app).get('/api/auth/config');
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ['configured', 'googleClientId']);
  assert.equal(response.body.configured, false);
  assert.equal(response.body.googleClientId, null);
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
