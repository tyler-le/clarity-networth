import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { deleteStore, hasLegacyStore, listUserStorageKeys, normalizeStore, readStore, userStorageKey, writeStore, encrypt, decrypt, removeDemoData } from './store.js';
import { databaseEnabled, deleteDatabaseStore, migrateDatabase, readDatabaseStore, recordAuditEvent, writeDatabaseStore } from './database.js';
import { calculateFire, cashRunway, classifyTransaction, hideDuplicateAccounts, investmentSummary, reconstructInvestmentHistory, removeEstimatedNetWorthHistory, spendingSummary, summarizeRange, snapshotInvestments, snapshotNetWorth, seedDemo } from './finance.js';
import { loadHistoricalPrices } from './market-data.js';
import { plaidConfigured, plaidPost } from './plaid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const loginAttempts = new Map();
const isProduction = process.env.NODE_ENV === 'production';
const dataEncryptionSecret = process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '';
const sessionSecretValue = process.env.SESSION_SECRET || (!isProduction ? dataEncryptionSecret || 'development-only-key-change-me' : '');
const sessionSecret = crypto.createHash('sha256').update(sessionSecretValue || crypto.randomBytes(32)).digest();
const allowedEmails = new Set(String(process.env.ALLOWED_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));

const productionSecurityErrors = [
  !dataEncryptionSecret || dataEncryptionSecret === 'development-only-key-change-me' ? 'DATA_ENCRYPTION_KEY is required.' : null,
  !process.env.SESSION_SECRET ? 'SESSION_SECRET is required and must differ from DATA_ENCRYPTION_KEY.' : null,
  process.env.SESSION_SECRET && process.env.SESSION_SECRET === dataEncryptionSecret ? 'SESSION_SECRET must differ from DATA_ENCRYPTION_KEY.' : null,
  String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'false' ? 'DEMO_MODE must be false.' : null,
  !process.env.DATA_DIR ? 'DATA_DIR must point to persistent storage.' : null,
  !process.env.DATABASE_URL ? 'DATABASE_URL is required.' : null
].filter(Boolean);

function securityReady() {
  return !isProduction || productionSecurityErrors.length === 0;
}

function createRateLimiter({ limit, windowMs, key = (req) => req.ip || req.socket.remoteAddress || 'unknown' }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = key(req);
    const entries = (buckets.get(bucketKey) || []).filter((time) => time > now - windowMs);
    if (entries.length >= limit) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    }
    entries.push(now);
    buckets.set(bucketKey, entries);
    next();
  };
}

const demoLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });
const authLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60_000 });
const privateLimiter = createRateLimiter({ limit: 240, windowMs: 60_000, key: (req) => req.user?.storageKey || req.ip || 'unknown' });
const syncLimiter = createRateLimiter({ limit: 8, windowMs: 10 * 60_000, key: (req) => req.user?.storageKey || req.ip || 'unknown' });

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb', verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://cdn.plaid.com https://accounts.google.com; frame-src https://cdn.plaid.com https://accounts.google.com; connect-src 'self' https://accounts.google.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The PWA intentionally serves no cached shell or financial data.
    if (/\/(index\.html|app\.js|styles\.css|chart-utils\.js|sw\.js|manifest\.webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  }
}));

async function loadStore(user) {
  const key = user?.storageKey;
  if (!key) throw new Error('Authenticated user storage is required.');
  let store = null;
  if (databaseEnabled()) {
    try { store = await readDatabaseStore(key); } catch (error) { console.error('Database store read failed:', error.message); throw new Error('Your secure financial store is temporarily unavailable.'); }
  }
  store = normalizeStore(store || readStore(key));
  const ownerEmail = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
  if (!store.accounts.length && !store.items.length && ownerEmail && user.email === ownerEmail && hasLegacyStore()) {
    store = readStore();
    await saveStore(user, store);
  }
  if (String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true') {
    seedDemo(store);
    await saveStore(user, store);
  } else if (removeDemoData(store)) {
    await saveStore(user, store);
  }
  return store;
}

async function saveStore(user, store) {
  await saveStoreByKey(user.storageKey, store);
}

async function saveStoreByKey(storageKey, store) {
  if (databaseEnabled()) await writeDatabaseStore(storageKey, store);
  // Retain an encrypted recovery mirror while PostgreSQL is the primary store.
  writeStore(store, storageKey);
}

function activeStore(store) {
  if (!store.settings?.demo_mode) return store;
  const demo = { ...store, accounts: [], positions: [], transactions: [], snapshots: [], items: [] };
  seedDemo(demo);
  return demo;
}

function demoPreviewStore() {
  const store = {
    items: [], accounts: [], positions: [], position_overrides: {}, investment_transactions: [],
    market_prices: {}, investment_snapshots: [], transactions: [], snapshots: [],
    settings: { targets: { fixed: 50, savings: 10, investments: 10, guilt_free: 30 }, demo_mode: true }
  };
  seedDemo(store);
  return store;
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
    if (allowedEmails.size && !allowedEmails.has(email)) return null;
    return { email, name: String(payload.name || ''), storageKey: userStorageKey(email) };
  } catch { return null; }
}

function setSession(res, user) {
  const value = signSession({ email: user.email, name: user.name, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.cookie('clarity_session', value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
}

function authConfigured() {
  return Boolean(securityReady() && process.env.GOOGLE_CLIENT_ID && dataEncryptionSecret && dataEncryptionSecret !== 'development-only-key-change-me');
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
      // Plaid's name may already be an institution/user nickname. Preserve any
      // Clarity-specific label separately so normal account refreshes never erase it.
      nickname: existing?.nickname || null,
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
    try {
      const holdingsData = await plaidPost('/investments/holdings/get', { access_token });
      const securities = new Map((holdingsData.securities || []).map((security) => [security.security_id, security]));
      store.positions = (store.positions || []).filter((position) => position.item_id !== item.id);
      for (const holding of holdingsData.holdings || []) {
        const security = securities.get(holding.security_id) || {};
        const id = `${item.id}:${holding.account_id}:${holding.security_id}`;
        store.positions.push({
          id,
          item_id: item.id, account_id: holding.account_id, security_id: holding.security_id,
          name: security.name || holding.security_id, ticker: security.ticker_symbol || null,
          type: security.type || 'other', asset_class_override: store.position_overrides?.[id] || null, quantity: Number(holding.quantity || 0),
          price: Number(holding.institution_price || 0), value: Number(holding.institution_value || 0),
          cost_basis: holding.cost_basis == null ? null : Number(holding.cost_basis), updated_at: new Date().toISOString(), demo: false
        });
      }
    } catch (e) { console.warn('Investments not available:', e.message); }
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
  store.investment_transactions ||= [];
  while (offset < total) {
    const data = await plaidPost('/investments/transactions/get', { access_token, start_date, end_date, options: { count: 500, offset } });
    total = Number(data.total_investment_transactions || 0);
    const securities = new Map((data.securities || []).map((security) => [security.security_id, security]));
    for (const transaction of data.investment_transactions || []) {
      const security = securities.get(transaction.security_id) || {};
      const investmentId = transaction.investment_transaction_id;
      const existingInvestment = store.investment_transactions.find((record) => record.id === investmentId);
      const recorded = { id: investmentId, item_id: item.id, account_id: transaction.account_id, security_id: transaction.security_id || null, ticker: security.ticker_symbol || null, security_type: security.type || null, date: transaction.date, quantity: Number(transaction.quantity || 0), price: Number(transaction.price || 0), amount: Number(transaction.amount || 0), type: transaction.type || null, subtype: transaction.subtype || null };
      if (existingInvestment) Object.assign(existingInvestment, recorded); else store.investment_transactions.push(recorded);
      const account = accounts.get(transaction.account_id);
      const name = String(transaction.name || '');
      const payrollBenefitAccount = /401\(?k\)?|403\(?b\)?|457|retirement|roth|\bira\b|\bhsa\b|health savings/i.test(`${account?.subtype || ''} ${account?.name || ''}`);
      // Do not treat trades, dividends, or price changes as plan contributions.
      const contribution = /contribution|employee.*deferral|payroll.*deferral|401\(?k\)?.*deposit|ira.*deposit|hsa.*deposit|health savings.*deposit/i.test(name);
      if (!payrollBenefitAccount || !contribution) continue;
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

async function backfillInvestmentHistory(store) {
  if (!process.env.MARKETDATA_API_TOKEN) return false;
  const endDate = new Date().toISOString().slice(0, 10);
  const historyYears = Math.max(1, Math.min(2, Number(process.env.MARKETDATA_HISTORY_YEARS || 1)));
  const start = new Date();
  start.setFullYear(start.getFullYear() - historyYears);
  const startDate = start.toISOString().slice(0, 10);
  const securities = new Map();
  for (const position of store.positions || []) if (position.ticker && position.type !== 'cash') securities.set(position.ticker, { ticker: position.ticker, type: position.type });
  for (const transaction of store.investment_transactions || []) if (transaction.ticker && transaction.security_type !== 'cash') securities.set(transaction.ticker, { ticker: transaction.ticker, type: transaction.security_type });
  store.market_prices ||= {};
  for (const security of securities.values()) {
    const cached = store.market_prices[security.ticker] || {};
    const latestCached = Object.keys(cached).sort().at(-1);
    const recentEnough = latestCached && (new Date(`${endDate}T12:00:00`) - new Date(`${latestCached}T12:00:00`)) < 8 * 86400000;
    if (Object.keys(cached).some((date) => date <= startDate) && recentEnough) continue;
    try {
      const prices = await loadHistoricalPrices({ symbol: security.ticker, securityType: security.type, from: startDate, to: endDate });
      store.market_prices[security.ticker] = { ...cached, ...prices };
    } catch (error) {
      // A price provider outage must never remove an already-built chart.
      console.warn(`Historical price refresh skipped for ${security.ticker}:`, error.message);
    }
  }
  const reconstructed = reconstructInvestmentHistory(store, endDate, historyYears);
  if (!reconstructed.length) return false;
  const verified = (store.investment_snapshots || []).filter((snapshot) => snapshot.source === 'verified');
  const verifiedDates = new Set(verified.map((snapshot) => snapshot.date));
  store.investment_snapshots = [...reconstructed.filter((snapshot) => !verifiedDates.has(snapshot.date)), ...verified].sort((a, b) => a.date.localeCompare(b.date));
  return true;
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
  res.status(securityReady() ? 200 : 503).json({ ok: securityReady(), plaidConfigured: plaidConfigured(), environment: process.env.PLAID_ENV || 'sandbox', securityReady: securityReady() });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ configured: authConfigured(), googleClientId: authConfigured() ? process.env.GOOGLE_CLIENT_ID : null });
});

app.get('/api/auth/me', (req, res) => {
  const user = verifySession(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
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
    if (allowedEmails.size && !allowedEmails.has(email)) return res.status(403).json({ error: 'This is an invite-only app. This Google account has not been invited yet.' });
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

// A seeded store is created in memory for the public preview; it never reads
// from or writes to a person's authenticated financial data.
app.get('/api/demo-preview', demoLimiter, (req, res) => {
  const store = demoPreviewStore();
  const range = ['1m', '3m', '6m', 'ytd', '1y'].includes(req.query.range) ? req.query.range : '1m';
  res.json({
    dashboard: {
      summary: summarizeRange(store),
      runway: cashRunway(store),
      accounts: store.accounts.filter((account) => !account.hidden).sort((a, b) => Number(b.current_balance || 0) - Number(a.current_balance || 0)),
      snapshots: store.snapshots.slice(-3650),
      items: [],
      plaidConfigured: false,
      demoMode: true
    },
    spending: spendingSummary(store, range),
    investments: investmentSummary(store),
    retirement: calculateFire(store, summarizeRange(store).netWorth)
  });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/plaid/webhook') return next();
  const user = verifySession(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  if (!securityReady()) return res.status(503).json({ error: 'The service is not securely configured.' });
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin) {
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (req.headers.origin !== expectedOrigin) return res.status(403).json({ error: 'Invalid request origin.' });
  }
  req.user = user;
  privateLimiter(req, res, next);
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/plaid/webhook' || !req.user) return next();
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/dashboard', async (req, res) => {
  const store = await loadStore(req.user);
  removeEstimatedNetWorthHistory(store);
  hideDuplicateAccounts(store);
  snapshotNetWorth(store);
  snapshotInvestments(store);
  await saveStore(req.user, store);
  const visibleStore = activeStore(store);
  const summary = summarizeRange(visibleStore);
  const snapshots = visibleStore.snapshots.slice(-3650);
  const accounts = visibleStore.accounts.filter((account) => !account.hidden).sort((a, b) => Number(b.current_balance || 0) - Number(a.current_balance || 0));
  res.json({
    summary,
    runway: cashRunway(visibleStore),
    accounts,
    snapshots,
    items: visibleStore.items.map(publicItem),
    plaidConfigured: plaidConfigured(),
    demoMode: Boolean(store.settings?.demo_mode) || visibleStore.accounts.some((a) => a.demo),
    appearance: store.settings?.appearance || { theme: 'light' }
  });
});

app.get('/api/spending', async (req, res) => {
  const range = ['1m', '3m', '6m', 'ytd', '1y'].includes(req.query.range) ? req.query.range : '1m';
  const store = activeStore(await loadStore(req.user));
  res.json(spendingSummary(store, range));
});

app.get('/api/investments', async (req, res) => {
  res.json(investmentSummary(activeStore(await loadStore(req.user))));
});

app.get('/api/retirement', async (req, res) => {
  const store = activeStore(await loadStore(req.user));
  res.json(calculateFire(store, summarizeRange(store).netWorth));
});

app.patch('/api/settings/retirement', async (req, res) => {
  const fields = ['age', 'retirement_age', 'withdrawal_rate', 'real_return', 'lean_multiplier', 'fat_multiplier'];
  const store = await loadStore(req.user);
  store.settings.fire ||= {};
  for (const field of fields) {
    if (req.body?.[field] === undefined) continue;
    const value = Number(req.body[field]);
    if (!Number.isFinite(value)) return res.status(400).json({ error: `Invalid ${field}.` });
    store.settings.fire[field] = value;
  }
  if (Number(store.settings.fire.retirement_age) < Number(store.settings.fire.age)) return res.status(400).json({ error: 'Retirement age must be after current age.' });
  await saveStore(req.user, store);
  const visibleStore = activeStore(store);
  res.json(calculateFire(visibleStore, summarizeRange(visibleStore).netWorth));
});

app.patch('/api/settings/appearance', async (req, res) => {
  const theme = String(req.body?.theme || '');
  if (!['light', 'dark'].includes(theme)) return res.status(400).json({ error: 'Appearance must be light or dark.' });
  const store = await loadStore(req.user);
  store.settings.appearance = { theme };
  await saveStore(req.user, store);
  res.json(store.settings.appearance);
});

app.get('/api/data-export', async (req, res) => {
  const store = await loadStore(req.user);
  // Connection tokens and sync cursors are service credentials, not portable
  // user data. They are intentionally excluded from an export.
  const exportStore = {
    ...store,
    items: store.items.map(({ access_token_enc, cursor, ...item }) => item)
  };
  await recordAuditEvent(req.user.storageKey, 'data_exported');
  res.setHeader('Content-Disposition', 'attachment; filename="clarity-financial-data.json"');
  res.json({ schemaVersion: 1, exportedAt: new Date().toISOString(), data: exportStore });
});

app.delete('/api/account', async (req, res) => {
  if (String(req.body?.confirmation || '') !== 'DELETE') return res.status(400).json({ error: 'Enter DELETE to permanently remove your data.' });
  const store = await loadStore(req.user);
  for (const item of store.items.filter((item) => !item.demo && item.access_token_enc)) {
    try { await plaidPost('/item/remove', { access_token: decrypt(item.access_token_enc) }); }
    catch (error) { console.warn('Plaid connection revocation skipped:', error.message); }
  }
  await deleteDatabaseStore(req.user.storageKey);
  deleteStore(req.user.storageKey);
  res.clearCookie('clarity_session', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' });
  res.json({ ok: true });
});

app.patch('/api/transactions/:id/category', async (req, res) => {
  const bucket = req.body?.bucket;
  if (!['fixed', 'savings', 'investments', 'guilt_free'].includes(bucket)) return res.status(400).json({ error: 'Invalid plan category.' });
  const store = await loadStore(req.user);
  const transaction = store.transactions.find((record) => record.id === req.params.id);
  if (!transaction || transaction.demo) return res.status(404).json({ error: 'Transaction not found.' });
  transaction.bucket = bucket;
  transaction.category_overridden = true;
  await saveStore(req.user, store);
  res.json({ ok: true });
});

app.patch('/api/accounts/:id/nickname', async (req, res) => {
  const nickname = String(req.body?.nickname || '').trim().replace(/\s+/g, ' ');
  if (nickname.length > 60) return res.status(400).json({ error: 'Account name must be 60 characters or fewer.' });
  const store = await loadStore(req.user);
  const account = store.accounts.find((record) => record.id === req.params.id && !record.demo);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  account.nickname = nickname || null;
  await saveStore(req.user, store);
  res.json({ ok: true, nickname: account.nickname });
});

app.patch('/api/positions/:id/asset-class', async (req, res) => {
  const assetClass = String(req.body?.asset_class || '').trim();
  const allowed = new Set(['', 'Equities', 'Funds', 'Fixed income', 'Cash', 'Crypto', 'Other']);
  if (!allowed.has(assetClass)) return res.status(400).json({ error: 'Invalid asset class.' });
  const store = await loadStore(req.user);
  const position = (store.positions || []).find((record) => record.id === req.params.id && !record.demo);
  if (!position) return res.status(404).json({ error: 'Holding not found.' });
  store.position_overrides ||= {};
  if (assetClass) store.position_overrides[position.id] = assetClass;
  else delete store.position_overrides[position.id];
  position.asset_class_override = assetClass || null;
  await saveStore(req.user, store);
  res.json({ ok: true, asset_class_override: position.asset_class_override });
});

app.post('/api/demo-mode', async (req, res) => {
  const store = await loadStore(req.user);
  store.settings.demo_mode = Boolean(req.body?.enabled);
  await saveStore(req.user, store);
  res.json({ ok: true, enabled: store.settings.demo_mode });
});

app.delete('/api/items/:id', async (req, res) => {
  const store = await loadStore(req.user);
  const item = store.items.find((candidate) => candidate.id === req.params.id);
  if (!item || item.demo) return res.status(404).json({ error: 'Connection not found.' });
  store.items = store.items.filter((candidate) => candidate.id !== item.id);
  store.accounts = store.accounts.filter((account) => account.item_id !== item.id);
  store.positions = (store.positions || []).filter((position) => position.item_id !== item.id);
  for (const key of Object.keys(store.position_overrides || {})) if (key.startsWith(`${item.id}:`)) delete store.position_overrides[key];
  store.transactions = store.transactions.filter((transaction) => transaction.item_id !== item.id);
  snapshotNetWorth(store);
  await saveStore(req.user, store);
  res.json({ ok: true });
});

app.post('/api/plaid/create_link_token', async (req, res) => {
  try {
    const body = {
      user: { client_user_id: req.user.storageKey },
      client_name: 'Clarity',
      // Transactions works across checking, credit, loan, and investment accounts.
      // Requiring Investments would exclude institutions (such as a credit-card-only
      // US Bank login) that have no compatible investment account.
      products: ['transactions'],
      additional_consented_products: ['investments', 'liabilities'],
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
    const store = await loadStore(req.user);
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
    try { await syncRetirementContributionsForItem(store, item); } catch (error) { console.warn('Investment history unavailable:', error.message); }
    try { await backfillInvestmentHistory(store); } catch (error) { console.warn('Investment history reconstruction unavailable:', error.message); }
    hideDuplicateAccounts(store);
    snapshotNetWorth(store);
    snapshotInvestments(store);
    await saveStore(req.user, store);
    res.json({ ok: true, item: publicItem(item) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, plaid: error.plaid });
  }
});

app.post('/api/sync', syncLimiter, async (_req, res) => {
  const store = await loadStore(_req.user);
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
  try { await backfillInvestmentHistory(store); } catch (error) { console.warn('Investment history reconstruction unavailable:', error.message); }
  snapshotNetWorth(store);
  snapshotInvestments(store);
  await saveStore(_req.user, store);
  res.json({ ok: results.every((r) => r.ok), results });
});

async function verifyPlaidWebhook(req) {
  const token = req.get('Plaid-Verification');
  if (!token || !req.rawBody?.length) return false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'ES256' || typeof header.kid !== 'string') return false;
    const verification = await plaidPost('/webhook_verification_key/get', { key_id: header.kid });
    const key = await importJWK(verification.key, 'ES256');
    const { payload } = await jwtVerify(token, key, { algorithms: ['ES256'], clockTolerance: '30s' });
    const expectedHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
    return typeof payload.request_body_sha256 === 'string'
      && payload.request_body_sha256.length === expectedHash.length
      && crypto.timingSafeEqual(Buffer.from(payload.request_body_sha256), Buffer.from(expectedHash));
  } catch (error) {
    console.warn('Rejected Plaid webhook:', error.message);
    return false;
  }
}

app.post('/api/plaid/webhook', async (req, res) => {
  if (!await verifyPlaidWebhook(req)) return res.sendStatus(401);
  res.sendStatus(200);
  const itemId = req.body?.item_id;
  if (!itemId) return;
  for (const storageKey of listUserStorageKeys()) {
    const store = normalizeStore(databaseEnabled() ? await readDatabaseStore(storageKey) : readStore(storageKey));
    const item = store.items.find((candidate) => candidate.plaid_item_id === itemId);
    if (!item) continue;
    try {
      await hydrateInstitutionBrand(item);
      await refreshAccountsForItem(store, item);
      hideDuplicateAccounts(store);
      snapshotNetWorth(store);
      await saveStoreByKey(storageKey, store);
    } catch (error) {
      console.warn('Webhook sync failed:', error.message);
    }
    return;
  }
});

app.post('/api/reset-demo', async (_req, res) => {
  if (String(process.env.DEMO_MODE || 'true').toLowerCase() !== 'true') return res.status(404).json({ error: 'Demo mode is disabled.' });
  const store = await loadStore(_req.user);
  store.items = [];
  store.accounts = [];
  store.positions = [];
  store.investment_transactions = [];
  store.market_prices = {};
  store.investment_snapshots = [];
  store.transactions = [];
  store.snapshots = [];
  seedDemo(store);
  await saveStore(_req.user, store);
  res.json({ ok: true });
});

app.post('/api/clear-demo', async (_req, res) => {
  const store = await loadStore(_req.user);
  removeDemoData(store);
  await saveStore(_req.user, store);
  res.json({ ok: true });
});

app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

export { app };

async function startServer() {
  if (databaseEnabled()) await migrateDatabase();
  app.listen(port, () => {
    console.log(`Clarity running at http://localhost:${port}`);
    console.log(`Plaid: ${plaidConfigured() ? `configured (${process.env.PLAID_ENV || 'sandbox'})` : 'not configured — demo mode available'}`);
  });
}

if (process.env.CLARITY_LISTEN !== 'false') {
  startServer().catch((error) => {
    console.error('Database migration failed; refusing to start:', error.message);
    process.exitCode = 1;
  });
}
