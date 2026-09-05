import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { hasLegacyStore, listUserStorageKeys, readStore, userStorageKey, writeStore, encrypt, decrypt, resetStore, removeDemoData } from './store.js';
import { classifyTransaction, hideDuplicateAccounts, removeEstimatedNetWorthHistory, spendingSummary, summarizeRange, snapshotNetWorth, seedDemo } from './finance.js';
import { plaidConfigured, plaidPost } from './plaid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const loginAttempts = new Map();
const sessionSecret = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'development-only-key-change-me').digest();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.plaid.com https://accounts.google.com; frame-src https://cdn.plaid.com https://accounts.google.com; connect-src 'self' https://accounts.google.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function loadStore(user) {
  const key = user?.storageKey;
  if (!key) throw new Error('Authenticated user storage is required.');
  let store = readStore(key);
  const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!store.accounts.length && !store.items.length && ownerEmail && user.email === ownerEmail && hasLegacyStore()) {
    store = readStore();
    writeStore(store, key);
  }
  if (String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true') {
    seedDemo(store);
    writeStore(store, key);
  } else if (removeDemoData(store)) {
    writeStore(store, key);
  }
  return store;
}

function saveStore(user, store) {
  writeStore(store, user.storageKey);
}

function activeStore(store) {
  if (!store.settings?.demo_mode) return store;
  const demo = { ...store, accounts: [], transactions: [], snapshots: [], items: [] };
  seedDemo(demo);
  return demo;
}

function readCookie(req, name) {
  const entry = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function signSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifySession(req) {
  const value = readCookie(req, 'clarity_session');
  if (!value) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(encoded).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.email || !payload.exp || payload.exp < Date.now()) return null;
    const email = String(payload.email).toLowerCase();
    return { email, name: String(payload.name || ''), storageKey: userStorageKey(email) };
  } catch { return null; }
}

function setSession(res, user) {
  const value = signSession({ email: user.email, name: user.name, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.cookie('clarity_session', value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
}

function authConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY !== 'development-only-key-change-me');
}

function publicUser(user) {
  return { email: user.email, name: user.name };
}

function publicItem(item) {
  return {
    id: item.id,
    plaid_item_id: item.plaid_item_id,
    institution_name: item.institution_name,
    institution_logo: item.institution_logo || null,
    created_at: item.created_at,
    last_synced_at: item.last_synced_at,
    demo: item.demo || false
  };
}

async function refreshAccountsForItem(store, item) {
  const access_token = decrypt(item.access_token_enc);
  const data = await plaidPost('/accounts/get', { access_token });
  const institution = item.institution_name || 'Connected institution';

  for (const account of data.accounts || []) {
    const existing = store.accounts.find((a) => a.plaid_account_id === account.account_id);
    const normalized = {
      id: existing?.id || crypto.randomUUID(),
      item_id: item.id,
      plaid_account_id: account.account_id,
      institution_name: institution,
      institution_logo: item.institution_logo || null,
      institution_color: item.institution_color || null,
      name: account.name,
      official_name: account.official_name,
      mask: account.mask,
      type: account.type,
      subtype: account.subtype,
      current_balance: account.balances?.current ?? account.balances?.available ?? 0,
      available_balance: account.balances?.available ?? null,
      limit: account.balances?.limit ?? null,
      iso_currency_code: account.balances?.iso_currency_code || 'USD',
      updated_at: new Date().toISOString(),
      demo: false
    };
    if (existing) Object.assign(existing, normalized);
    else store.accounts.push(normalized);
  }

  const types = new Set((data.accounts || []).map((a) => a.type));
  if (types.has('investment')) {
    try { await plaidPost('/investments/holdings/get', { access_token }); } catch (e) { console.warn('Investments not available:', e.message); }
  }
  if (types.has('credit') || types.has('loan')) {
    try { await plaidPost('/liabilities/get', { access_token }); } catch (e) { console.warn('Liabilities not available:', e.message); }
  }
}

async function syncTransactionsForItem(store, item) {
  const access_token = decrypt(item.access_token_enc);
  let cursor = item.cursor || undefined;
  let hasMore = true;
  while (hasMore) {
    const data = await plaidPost('/transactions/sync', { access_token, cursor, count: 500, options: { include_personal_finance_category: true } });
    const changes = [...(data.added || []), ...(data.modified || [])];
    for (const transaction of changes) {
      const existing = store.transactions.find((record) => record.plaid_transaction_id === transaction.transaction_id);
      const baseBucket = classifyTransaction(transaction);
      const transferTarget = plannedTransferBucket(store, transaction, baseBucket);
      const normalized = {
        id: existing?.id || crypto.randomUUID(), item_id: item.id, plaid_transaction_id: transaction.transaction_id,
        account_id: transaction.account_id, merchant_name: transaction.merchant_name, name: transaction.name,
        amount: transaction.amount, date: transaction.date, bucket: existing?.category_overridden ? existing.bucket : (transferTarget || baseBucket), excluded: existing?.excluded || false,
        pending: transaction.pending, pfc_primary: transaction.personal_finance_category?.primary || '',
        pfc_detailed: transaction.personal_finance_category?.detailed || '', demo: false
      };
      if (existing) Object.assign(existing, normalized); else store.transactions.push(normalized);
    }
    const removed = new Set((data.removed || []).map((transaction) => transaction.transaction_id));
    if (removed.size) store.transactions = store.transactions.filter((transaction) => !removed.has(transaction.plaid_transaction_id));
    cursor = data.next_cursor;
    hasMore = Boolean(data.has_more);
  }
  item.cursor = cursor || item.cursor || null;
}

function plannedTransferBucket(store, transaction, bucket) {
  if (bucket !== 'transfer' || Number(transaction.amount || 0) <= 0) return null;
  const description = `${transaction.merchant_name || ''} ${transaction.name || ''}`.toLowerCase();
  const targets = store.accounts.filter((account) => !account.hidden && (account.type === 'investment' || (account.type === 'depository' && /savings/i.test(account.subtype || account.name || ''))));
  for (const target of targets) {
    const institutionWords = String(target.institution_name || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
    const nameWords = String(target.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 5);
    if (![...institutionWords, ...nameWords].some((word) => description.includes(word))) continue;
    return target.type === 'investment' ? 'investments' : 'savings';
  }
  return null;
}

async function syncRetirementContributionsForItem(store, item) {
  const access_token = decrypt(item.access_token_enc);
  const end_date = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const start_date = start.toISOString().slice(0, 10);
  let offset = 0;
  let total = Infinity;
  const accounts = new Map(store.accounts.map((account) => [account.plaid_account_id, account]));
  while (offset < total) {
    const data = await plaidPost('/investments/transactions/get', { access_token, start_date, end_date, options: { count: 500, offset } });
    total = Number(data.total_investment_transactions || 0);
    for (const transaction of data.investment_transactions || []) {
      const account = accounts.get(transaction.account_id);
      const name = String(transaction.name || '');
      const retirementAccount = /401\(?k\)?|403\(?b\)?|457|retirement|roth|\bira\b/i.test(`${account?.subtype || ''} ${account?.name || ''}`);
      // Do not treat trades, dividends, or price changes as plan contributions.
      const contribution = /contribution|employee.*deferral|payroll.*deferral|401\(?k\)?.*deposit|ira.*deposit/i.test(name);
      if (!retirementAccount || !contribution) continue;
      const plaid_transaction_id = `investment:${transaction.investment_transaction_id}`;
      const existing = store.transactions.find((record) => record.plaid_transaction_id === plaid_transaction_id);
      const normalized = {
        id: existing?.id || crypto.randomUUID(), item_id: item.id, plaid_transaction_id, account_id: transaction.account_id,
        merchant_name: name, name, amount: Math.abs(Number(transaction.amount || 0)), date: transaction.date,
        bucket: 'investments', excluded: existing?.excluded || false, pending: false,
        pfc_primary: 'RETIREMENT_CONTRIBUTION', pfc_detailed: '', source: 'investment_transaction', demo: false
      };
      if (existing) Object.assign(existing, normalized); else store.transactions.push(normalized);
    }
    offset += 500;
  }
}

async function hydrateInstitutionBrand(item) {
  if (item.institution_logo || !item.institution_name) return;
  try {
    const data = await plaidPost('/institutions/search', {
      query: item.institution_name,
      country_codes: ['US'],
      options: { include_optional_metadata: true }
    });
    const normalized = item.institution_name.trim().toLowerCase();
    const institution = (data.institutions || []).find((candidate) => candidate.name?.trim().toLowerCase() === normalized) || data.institutions?.[0];
    if (!institution) return;
    if (institution.logo) item.institution_logo = `data:image/png;base64,${institution.logo}`;
    if (institution.primary_color) item.institution_color = institution.primary_color;
  } catch (error) {
    console.warn('Institution brand unavailable:', error.message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, plaidConfigured: plaidConfigured(), environment: process.env.PLAID_ENV || 'sandbox' });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ configured: authConfigured(), googleClientId: authConfigured() ? process.env.GOOGLE_CLIENT_ID : null });
});

app.get('/api/auth/me', (req, res) => {
  const user = verifySession(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/google', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter((time) => time > Date.now() - 10 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
  try {
    if (!authConfigured()) return res.status(503).json({ error: 'Google sign-in is not configured yet.' });
    const ticket = await googleClient.verifyIdToken({ idToken: req.body?.credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = String(payload?.email || '').toLowerCase();
    if (!payload?.email_verified) return res.status(403).json({ error: 'A verified Google email is required.' });
    loginAttempts.delete(ip);
    const user = { email, name: String(payload.name || '') };
    setSession(res, user);
    res.json({ ok: true, user: publicUser(user) });
  } catch {
    loginAttempts.set(ip, [...recent, Date.now()]);
    res.status(401).json({ error: 'Google sign-in could not be verified.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('clarity_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/plaid/webhook') return next();
  const user = verifySession(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (req.headers.origin !== expectedOrigin) return res.status(403).json({ error: 'Invalid request origin.' });
  }
  req.user = user;
  next();
});

app.get('/api/dashboard', (req, res) => {
  const store = loadStore(req.user);
  removeEstimatedNetWorthHistory(store);
  hideDuplicateAccounts(store);
  snapshotNetWorth(store);
  saveStore(req.user, store);
  const visibleStore = activeStore(store);
  const summary = summarizeRange(visibleStore);
  const snapshots = visibleStore.snapshots.slice(-3650);
  const accounts = visibleStore.accounts.filter((account) => !account.hidden).sort((a, b) => Number(b.current_balance || 0) - Number(a.current_balance || 0));
  res.json({
    summary,
    accounts,
    snapshots,
    items: visibleStore.items.map(publicItem),
    plaidConfigured: plaidConfigured(),
    demoMode: Boolean(store.settings?.demo_mode) || visibleStore.accounts.some((a) => a.demo)
  });
});

app.get('/api/spending', (req, res) => {
  const range = ['1m', '3m', 'ytd', '1y'].includes(req.query.range) ? req.query.range : '1m';
  const store = activeStore(loadStore(req.user));
  res.json(spendingSummary(store, range));
});

app.patch('/api/transactions/:id/category', (req, res) => {
  const bucket = req.body?.bucket;
  if (!['fixed', 'savings', 'investments', 'guilt_free'].includes(bucket)) return res.status(400).json({ error: 'Invalid plan category.' });
  const store = loadStore(req.user);
  const transaction = store.transactions.find((record) => record.id === req.params.id);
  if (!transaction || transaction.demo) return res.status(404).json({ error: 'Transaction not found.' });
  transaction.bucket = bucket;
  transaction.category_overridden = true;
  saveStore(req.user, store);
  res.json({ ok: true });
});

app.post('/api/demo-mode', (req, res) => {
  const store = loadStore(req.user);
  store.settings.demo_mode = Boolean(req.body?.enabled);
  saveStore(req.user, store);
  res.json({ ok: true, enabled: store.settings.demo_mode });
});

app.delete('/api/items/:id', (req, res) => {
  const store = loadStore(req.user);
  const item = store.items.find((candidate) => candidate.id === req.params.id);
  if (!item || item.demo) return res.status(404).json({ error: 'Connection not found.' });
  store.items = store.items.filter((candidate) => candidate.id !== item.id);
  store.accounts = store.accounts.filter((account) => account.item_id !== item.id);
  store.transactions = store.transactions.filter((transaction) => transaction.item_id !== item.id);
  snapshotNetWorth(store);
  saveStore(req.user, store);
  res.json({ ok: true });
});

app.post('/api/plaid/create_link_token', async (req, res) => {
  try {
    const body = {
      user: { client_user_id: req.user.storageKey },
      client_name: 'Clarity',
      products: ['transactions', 'investments'],
      additional_consented_products: ['liabilities'],
      country_codes: ['US'],
      language: 'en',
      transactions: { days_requested: 365 }
    };
    if (process.env.PLAID_WEBHOOK_URL) body.webhook = process.env.PLAID_WEBHOOK_URL;
    const data = await plaidPost('/link/token/create', body);
    res.json({ link_token: data.link_token });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, plaid: error.plaid });
  }
});

app.post('/api/plaid/exchange_public_token', async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) return res.status(400).json({ error: 'public_token is required' });
    const exchanged = await plaidPost('/item/public_token/exchange', { public_token });
    const store = loadStore(req.user);
    const item = {
      id: crypto.randomUUID(),
      plaid_item_id: exchanged.item_id,
      access_token_enc: encrypt(exchanged.access_token),
      institution_name: institution_name || 'Connected institution',
      institution_id: req.body.institution_id || null,
      cursor: null,
      created_at: new Date().toISOString(),
      last_synced_at: null,
      demo: false
    };
    store.items.push(item);
    await hydrateInstitutionBrand(item);
    await refreshAccountsForItem(store, item);
    try { await syncTransactionsForItem(store, item); } catch (error) { console.warn('Transactions not ready:', error.message); }
    hideDuplicateAccounts(store);
    snapshotNetWorth(store);
    saveStore(req.user, store);
    res.json({ ok: true, item: publicItem(item) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, plaid: error.plaid });
  }
});

app.post('/api/sync', async (_req, res) => {
  const store = loadStore(_req.user);
  const results = [];
  for (const item of store.items.filter((i) => !i.demo)) {
    try {
      await hydrateInstitutionBrand(item);
      await refreshAccountsForItem(store, item);
      try { await syncTransactionsForItem(store, item); } catch (error) { console.warn('Transactions sync failed:', error.message); }
      try { await syncRetirementContributionsForItem(store, item); } catch (error) { console.warn('Investment contribution sync unavailable:', error.message); }
      hideDuplicateAccounts(store);
      results.push({ item: item.institution_name, ok: true });
    } catch (error) {
      results.push({ item: item.institution_name, ok: false, error: error.message });
    }
  }
  snapshotNetWorth(store);
  saveStore(_req.user, store);
  res.json({ ok: results.every((r) => r.ok), results });
});

app.post('/api/plaid/webhook', async (req, res) => {
  res.sendStatus(200);
  const itemId = req.body?.item_id;
  if (!itemId) return;
  for (const storageKey of listUserStorageKeys()) {
    const store = readStore(storageKey);
    const item = store.items.find((candidate) => candidate.plaid_item_id === itemId);
    if (!item) continue;
    try {
      await hydrateInstitutionBrand(item);
      await refreshAccountsForItem(store, item);
      hideDuplicateAccounts(store);
      snapshotNetWorth(store);
      writeStore(store, storageKey);
    } catch (error) {
      console.warn('Webhook sync failed:', error.message);
    }
    return;
  }
});

app.post('/api/reset-demo', (_req, res) => {
  if (String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'true') return res.status(404).json({ error: 'Demo mode is disabled.' });
  resetStore(_req.user.storageKey);
  const store = readStore(_req.user.storageKey);
  seedDemo(store);
  saveStore(_req.user, store);
  res.json({ ok: true });
});

app.post('/api/clear-demo', (_req, res) => {
  const store = loadStore(_req.user);
  removeDemoData(store);
  saveStore(_req.user, store);
  res.json({ ok: true });
});

app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => {
  console.log(`Clarity running at http://localhost:${port}`);
  console.log(`Plaid: ${plaidConfigured() ? `configured (${process.env.PLAID_ENV || 'sandbox'})` : 'not configured — demo mode available'}`);
});
