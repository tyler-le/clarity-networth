import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clarity-http-test-'));
const previousEnvironment = {
  CLARITY_LISTEN: process.env.CLARITY_LISTEN,
  DATA_DIR: process.env.DATA_DIR,
  NODE_ENV: process.env.NODE_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY
};

process.env.CLARITY_LISTEN = 'false';
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.DEMO_MODE = 'false';
process.env.ENCRYPTION_KEY = 'integration-test-encryption-key';
const { app } = await import(`../../server.js?integration=${Date.now()}`);
const integrationTest = process.env.CODEX_SANDBOX_NETWORK_DISABLED ? test.skip : test;

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
});

integrationTest('serves a complete public demo without a session', async () => {
  const response = await request(app).get('/api/demo-preview?range=1y');
  assert.equal(response.status, 200);
  assert.equal(response.body.dashboard.demoMode, true);
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
    ['post', '/api/sync']
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

integrationTest('rejects unsigned Plaid webhooks before processing financial data', async () => {
  const response = await request(app).post('/api/plaid/webhook').send({ item_id: 'untrusted-item' });
  assert.equal(response.status, 401);
});
