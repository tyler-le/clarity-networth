import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { deleteStore, hasLegacyStore, listUserStorageKeys, normalizeStore, readStore, userStorageKey, writeStore, encrypt, decrypt, removeDemoData } from './lib/store.js';
import { assertSafeFinancialStoreWrite, chooseSaferStore, hasConnectedFinancialData } from './lib/store-safety.js';
import { consumeRateLimit, databaseEnabled, databaseHealthy, deleteDatabaseStore, listDatabaseStoreKeys, migrateDatabase, readDatabaseStore, recordAuditEvent, recordDependencyEvent, recordLaunchEvent, writeDatabaseStore } from './lib/database.js';
import { accountBalanceHistory, calculateFire, cashFlowType, cashRunway, classifyTransaction, clarityCheckin, connectionHealth, debtPayoffPlan, goalProgress, hideDuplicateAccounts, historicalSecurity, investmentContributions, investmentDetailHistory, investmentLinkBalances, investmentSummary, monthlyReview, recurringCharges, removeEstimatedNetWorthHistory, repairIncomingClassifications, repairTransferClassifications, spendingSummary, summarizeRange, snapshotInvestments, snapshotNetWorth, seedDemo } from './lib/finance.js';
import { investmentLedgerPages, plaidConfigured, plaidPost } from './lib/plaid.js';
import { loadHistoricalPrices } from './lib/market-data.js';
import { historyStart } from './lib/history.js';
import { plaidErrorCode, publicErrorPayload } from '../public/customer-error.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const app = express();
const port = Number(process.env.PORT || 3000);
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const loginAttempts = new Map();
const isProduction = process.env.NODE_ENV === 'production';
const dataEncryptionSecret = process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '';
const sessionSecretValue = process.env.SESSION_SECRET || (!isProduction ? dataEncryptionSecret || 'development-only-key-change-me' : '');
const sessionSecret = crypto.createHash('sha256').update(sessionSecretValue || crypto.randomBytes(32)).digest();
const inviteCodeHash = process.env.INVITE_CODE ? crypto.createHash('sha256').update(process.env.INVITE_CODE).digest() : null;
const DAILY_SYNC_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.DAILY_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000);
// Plaid can take a short time to prepare its initial investment activity
// extraction. Poll conservatively as a webhook fallback, rather than making a
// person wait for tomorrow's account refresh.
const INVESTMENT_HISTORY_RETRY_MS = Math.max(2 * 60 * 1000, Number(process.env.INVESTMENT_HISTORY_RETRY_MS) || 5 * 60 * 1000);
const MAX_INVESTMENT_HISTORY_RETRY_ATTEMPTS = Math.max(1, Math.min(12, Number(process.env.MAX_INVESTMENT_HISTORY_RETRY_ATTEMPTS) || 6));
const MAX_LINKED_ITEMS = Math.min(30, Math.max(1, Number(process.env.MAX_LINKED_ITEMS) || 15));
const userSyncQueues = new Map();
const providerLimitFallback = new Map();
const plaidWebhookKeyCache = new Map();
const reconnectSessions = new Map();

// This is deliberately not a general analytics API. The allowlist lives in
// database.js, and failures are non-blocking so operational measurement can
// never prevent a person from using their financial data.
function trackLaunchEvent(user, eventName) {
  return recordLaunchEvent(user?.storageKey || null, eventName).catch((error) => {
    logOperationalError('Launch telemetry unavailable', error);
  });
}

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
const webhookLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

function opaqueRateLimitKey(value) {
  return crypto.createHmac('sha256', sessionSecret).update(String(value || '')).digest('hex');
}

function consumeFallbackProviderLimit(scope, subjectKey, windowMs, limit) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = `${scope}:${subjectKey}:${windowStart}`;
  const count = Number(providerLimitFallback.get(key) || 0);
  if (count >= limit) return false;
  providerLimitFallback.set(key, count + 1);
  return true;
}

async function consumeProviderLimit(scope, subjectKey, windowMs, limit) {
  if (!databaseEnabled()) return consumeFallbackProviderLimit(scope, subjectKey, windowMs, limit);
  return consumeRateLimit({ scope, subjectKey, windowMs, limit });
}

function plaidCostLimiter({ scope, userLimit, ipLimit, windowMs }) {
  return async (req, res, next) => {
    try {
      const [userAllowed, ipAllowed] = await Promise.all([
        consumeProviderLimit(`${scope}.user`, opaqueRateLimitKey(req.user.storageKey), windowMs, userLimit),
        consumeProviderLimit(`${scope}.ip`, opaqueRateLimitKey(req.ip || req.socket.remoteAddress), windowMs, ipLimit)
      ]);
      if (!userAllowed || !ipAllowed) {
        const retryAfterSeconds = Math.ceil(windowMs / 1000);
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json(publicErrorPayload('rate_limited', { retryAfterSeconds }));
      }
      next();
    } catch (error) {
      // Fail closed: a missing cost-control store must never permit billable
      // provider calls without a limit.
      logOperationalError('Provider rate-limit check unavailable', error, 'error');
      res.status(503).json(publicErrorPayload('connection_unavailable'));
    }
  };
}

// Provider diagnostics belong in server logs, never in a browser response.
// This prevents credentials, provider request details, and opaque error codes
// from becoming part of a customer's connection experience.
function publicPlaidError(error, fallback) {
  const code = plaidErrorCode(error?.plaid?.error_code);
  return publicErrorPayload(code, code === 'connection_unavailable' && fallback ? { message: fallback } : {});
}

// Provider and database errors can include institution-specific context. Keep
// operational logs useful without retaining account names, request details, or
// opaque provider messages that may contain personal financial information.
function safeErrorCode(error) {
  const code = String(error?.plaid?.error_code || error?.code || error?.status || '').trim();
  return /^[A-Z0-9_-]{1,80}$/i.test(code) ? ` [${code}]` : '';
}

function logOperationalError(context, error, level = 'warn') {
  console[level](`${context}${safeErrorCode(error)}`);
}

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
// Financial responses are account-specific. These directives protect users if
// a CDN, proxy, or hosting layer is configured with broad caching rules.
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.vary('Cookie');
  res.vary('Authorization');
  next();
});

// Internal API health is grouped into stable route families. We intentionally
// never retain the requested path, parameter values, user identity, or body;
// the operations report needs reliability signals, not customer activity.
function apiOperation(pathname) {
  if (pathname === '/api/launch-event') return null;
  if (pathname === '/api/health') return 'health';
  if (pathname.startsWith('/api/auth/')) return 'authentication';
  if (pathname === '/api/dashboard') return 'dashboard';
  if (pathname === '/api/spending') return 'cash_flow';
  if (pathname === '/api/investments') return 'investments';
  if (pathname === '/api/retirement' || pathname.startsWith('/api/settings/')) return 'planning_settings';
  if (pathname.startsWith('/api/plaid/')) return 'account_connection';
  if (pathname.startsWith('/api/items/')) return 'connected_accounts';
  if (pathname.startsWith('/api/manual-')) return 'manual_accounts';
  if (pathname.startsWith('/api/transactions/')) return 'transactions';
  if (pathname === '/api/data-export') return 'data_export';
  if (pathname === '/api/account') return 'account_lifecycle';
  if (pathname.startsWith('/api/demo')) return 'public_demo';
  // Unknown routes are intentionally not counted. A vague catch-all makes an
  // operations dashboard less useful and can conceal a route that deserves
  // its own explicit, privacy-safe reliability group.
  return null;
}

app.use('/api', (req, res, next) => {
  const operation = apiOperation(req.path);
  if (!operation) return next();
  const startedAt = Date.now();
  res.once('finish', () => {
    const statusCode = res.statusCode;
    const outcome = statusCode >= 500 ? 'server_error' : statusCode >= 400 ? 'client_error' : 'success';
    void recordDependencyEvent({ dependency: 'clarity_api', operation, outcome, statusCode, durationMs: Date.now() - startedAt }).catch(() => {});
  });
  next();
});
function isDevelopmentRequest(req) {
  const host = String(req.hostname || req.get('host') || '').split(':')[0].toLowerCase();
  // The host header is useful for the staging presentation, but it is not a
  // security boundary. Railway supplies this environment value separately for
  // the staging deployment; production can never opt into dev behavior from a
  // request-supplied Host header.
  if (process.env.RAILWAY_ENVIRONMENT_NAME === 'staging') return true;
  return !isProduction && (host === 'localhost' || host === '127.0.0.1' || host.includes('staging'));
}

// An installed PWA uses its manifest/icon rather than the in-app environment
// badge. Serve a subtly marked icon only from development so a tester cannot
// accidentally mistake a staging install for the production app.
app.get('/app-icon.svg', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
  res.type('svg').sendFile(path.join(projectRoot, 'public', isDevelopmentRequest(req) ? 'icon-dev.svg' : 'icon.svg'));
});
app.get('/manifest.webmanifest', (req, res) => {
  const development = isDevelopmentRequest(req);
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
  res.type('application/manifest+json').json({
    name: development ? 'Clarity Dev' : 'Clarity Net Worth',
    short_name: development ? 'Clarity DEV' : 'Clarity',
    start_url: '/',
    display: 'standalone',
    background_color: development ? '#123b2a' : '#f6f7f4',
    theme_color: development ? '#123b2a' : '#f6f7f4',
    description: development ? 'Clarity development environment' : 'A focused net worth and account tracker',
    icons: [{ src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }]
  });
});
app.use(express.static(path.join(projectRoot, 'public'), {
  setHeaders(res, filePath) {
    // The PWA intentionally serves no cached shell or financial data.
    if (/\/(index\.html|app\.js|styles\.css|chart-utils\.js|customer-error\.js|sw\.js|manifest\.webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
      res.setHeader('CDN-Cache-Control', 'no-store');
      res.setHeader('Surrogate-Control', 'no-store');
    }
  }
}));

// Railway's edge can occasionally retain an older response for the stable
// /app.js path even when it carries no-store directives. Keep the application
// entrypoint on a separate, explicitly dynamic route so an HTML deployment
// and the JavaScript it loads always come from the same release.
app.get('/runtime/app.js', (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, max-age=0, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.type('js').sendFile(path.join(projectRoot, 'public', 'app.js'));
});

function escapeLegalText(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[character]));
}

function legalPage(title, content) {
  const company = escapeLegalText(process.env.PUBLIC_COMPANY_NAME || 'Clarity');
  const supportEmail = escapeLegalText(process.env.SUPPORT_EMAIL || process.env.OWNER_EMAIL || '');
  const contact = supportEmail ? `<a href="mailto:${supportEmail}">${supportEmail}</a>` : 'the support contact listed in the app';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f6f7f4"><title>${company} · ${title}</title><link rel="icon" href="/app-icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/app-icon.svg"><link rel="stylesheet" href="/styles.css"></head><body class="legal-body"><main class="legal-page"><header class="legal-header"><a class="legal-brand" href="/" aria-label="Go to ${company}"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 17.5h14M6.5 14.5l3.1-3.1 2.7 2.2 5.1-5.2" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.4" cy="8.4" r="1.45" fill="currentColor"/></svg></span><span>${company}</span></a><a class="legal-back" href="/">Back to app <span aria-hidden="true">→</span></a></header><article class="legal-card"><p class="legal-kicker">Legal</p><h1>${title}</h1><div class="legal-content">${content(contact)}</div><p class="legal-updated">Last updated: September 6, 2026</p></article></main></body></html>`;
}

app.get('/privacy', (_req, res) => {
  res.type('html').send(legalPage('Privacy Policy', (contact) => `<p>Clarity helps you view connected financial accounts. We collect your sign-in email and the financial information your chosen institutions make available through Plaid, including account balances, transactions, and investment holdings.</p><h2>How we use data</h2><p>We use this information only to provide the features you request: account aggregation, net-worth tracking, cash-flow views, investment summaries, and retirement estimates. We do not sell personal financial information or use it for advertising.</p><h2>Limited operational measurement</h2><p>To improve the private beta, we record a small set of product-health events, such as a completed sign-in, successful account link, successful or failed sync, section view, or meaningful card action. For repeated use, we keep only an aggregate daily count for each event type. These records never include balances, transactions, merchants, account names, financial inputs, click coordinates, session replay, raw IP addresses, or advertising profiles. They use an opaque account key, are kept for up to 90 days, and are deleted when you delete your account.</p><h2>How data is protected</h2><p>Connection credentials are exchanged through Plaid. Access tokens and stored financial data are encrypted at rest; the app serves over HTTPS. Access is limited to the signed-in account owner.</p><h2>Your choices</h2><p>You can unlink an institution at any time. In Profile, you can download an export of your stored data or permanently delete your account and financial data. Deletion also asks Plaid to revoke linked Items.</p><h2>Retention and contact</h2><p>We keep your data while your account is active, except where retention is required by law. For privacy questions or deletion help, contact ${contact}.</p>`));
});

app.get('/terms', (_req, res) => {
  res.type('html').send(legalPage('Terms of Service', (contact) => `<p>Clarity is a personal financial-information tool. By using it, you authorize us to retrieve and display information from the financial institutions you choose to connect.</p><h2>Not financial advice</h2><p>Clarity provides educational estimates and organizational tools only. It does not provide investment, tax, legal, accounting, or other professional advice. Retirement estimates are illustrations based on your selected assumptions, not guarantees.</p><h2>Your responsibilities</h2><p>Use accurate information, protect your sign-in account, and review connected-account data before making financial decisions. You may unlink accounts or delete your data at any time.</p><h2>Service availability</h2><p>Financial institutions and data providers can delay, limit, or change available data. We aim to handle those failures safely, but do not guarantee uninterrupted or error-free information.</p><h2>Contact</h2><p>Questions about these terms can be sent to ${contact}.</p>`));
});

app.get('/support', (_req, res) => {
  res.type('html').send(legalPage('Help & Feedback', (contact) => `<p>Clarity is in private beta. Your feedback helps make the app clearer, more reliable, and safer before a broader release.</p><h2>Need help?</h2><p>For an account-linking issue, a data question, or a privacy request, contact ${contact}. Please do not include account numbers, passwords, access codes, or screenshots containing sensitive financial information.</p><h2>Share feedback</h2><p>Tell us what you were trying to do, what you expected, and what happened. Device and browser details are helpful; financial details are not required.</p>`));
});

async function loadStore(user) {
  const key = user?.storageKey;
  if (!key) throw new Error('Authenticated user storage is required.');
  let store = await loadStoreByKey(key);
  if (repairTransferClassifications(store) + repairIncomingClassifications(store)) await saveStore(user, store);
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

async function loadStoreByKey(key) {
  const mirror = normalizeStore(readStore(key));
  let primary = null;
  if (databaseEnabled()) {
    try { primary = await readDatabaseStore(key); } catch (error) { logOperationalError('Database store read failed', error, 'error'); throw new Error('Your secure financial store is temporarily unavailable.'); }
  }
  const primaryStore = normalizeStore(primary || mirror);
  // A valid but empty database row must never outrank the encrypted volume
  // mirror that still has linked data. Heal the primary before returning it.
  const chosen = chooseSaferStore(primaryStore, mirror);
  if (chosen === mirror && primaryStore !== mirror) {
    if (databaseEnabled()) await writeDatabaseStore(key, mirror);
    return mirror;
  }
  return chosen;
}

async function saveStore(user, store, options = {}) {
  await saveStoreByKey(user.storageKey, store, options);
}

async function saveStoreByKey(storageKey, store, options = {}) {
  // Guard the shared persistence boundary, rather than relying on every
  // caller to notice when a fallback store is empty. This is intentionally
  // checked against the primary encrypted store before any write occurs.
  const previous = await loadStoreByKey(storageKey);
  assertSafeFinancialStoreWrite(previous, store, options);
  if (databaseEnabled()) await writeDatabaseStore(storageKey, store);
  // Retain an encrypted recovery mirror while PostgreSQL is the primary store.
  writeStore(store, storageKey);
}

function activeStore(store) {
  if (!store.settings?.demo_mode) return store;
  // Demo mode must be a self-contained, representative scenario. Carrying a
  // signed-in person's retirement assumptions into the seeded records can make
  // the demo tell a contradictory story (for example, "Needs a savings pace")
  // even though its own contributions reach Coast independence. Appearance is
  // returned from the real store separately, so it remains personal while all
  // financial inputs below are deliberately demo-only.
  const demo = {
    ...store,
    accounts: [], positions: [], manual_holdings: [], transactions: [], snapshots: [], items: [],
    settings: { targets: { fixed: 50, savings: 10, investments: 10, guilt_free: 30 }, demo_mode: true }
  };
  seedDemo(demo);
  return demo;
}

function demoPreviewStore() {
  const store = {
    items: [], accounts: [], positions: [], manual_holdings: [], position_overrides: {}, investment_transactions: [],
    market_prices: {}, investment_snapshots: [], investment_position_snapshots: [], transactions: [], snapshots: [],
    settings: { targets: { fixed: 50, savings: 10, investments: 10, guilt_free: 30 }, demo_mode: true }
  };
  seedDemo(store);
  return store;
}

function developmentMockConnectionsEnabled(req) {
  // This is a deliberate staging-only escape hatch for exercising the Link
  // lifecycle without spending a person's Plaid quota. It is double-gated by
  // an environment variable that is never set in production and by the
  // development host check.
  return process.env.DEV_MOCK_CONNECTIONS === 'true' && isDevelopmentRequest(req);
}

function seedDevelopmentMockHistory(store, item, fixture) {
  // This is deliberately only a development fixture. Its one-year observed
  // ledger lets us test real range and drill-in behavior without calling a
  // provider or presenting fabricated history as member data.
  const earliest = new Date();
  earliest.setDate(earliest.getDate() - 365);
  const startDate = earliest.toISOString().slice(0, 10);
  const targetAccounts = new Map((store.accounts || [])
    .filter((account) => account.item_id === item.id)
    .map((account) => [String(account.plaid_account_id || '').replace(/^development-mock-/, ''), account]));
  const sourceIds = new Set(targetAccounts.keys());
  const targetAccountIds = new Set([...targetAccounts.values()].map((account) => account.plaid_account_id));
  const targetPositions = new Map((store.positions || [])
    .filter((position) => {
      const sourceId = [...targetAccounts.entries()].find(([, account]) => account.id === position.account_id)?.[0];
      return Boolean(sourceId);
    })
    .map((position) => {
      const sourceId = [...targetAccounts.entries()].find(([, account]) => account.id === position.account_id)?.[0];
      return [`demo-position-${position.ticker}-${sourceId}`, position];
    }));

  // Reset only this explicit test institution before making a reproducible
  // fixture. Real institutions and user-added records are never touched.
  store.transactions = (store.transactions || []).filter((transaction) => transaction.item_id !== item.id);
  store.transactions.push(...fixture.transactions
    .filter((transaction) => transaction.date >= startDate && sourceIds.has(transaction.account_id))
    .map((transaction) => ({
      ...transaction,
      id: crypto.randomUUID(),
      plaid_transaction_id: `development-mock-${transaction.plaid_transaction_id || transaction.id}`,
      item_id: item.id,
      account_id: targetAccounts.get(transaction.account_id).id,
      demo: false,
      development_mock: true
    })));
  store.transactions.sort((left, right) => String(left.date).localeCompare(String(right.date)));

  store.investment_position_snapshots = (store.investment_position_snapshots || [])
    .filter((snapshot) => !targetAccountIds.has(snapshot.account_id));
  const copiedSnapshots = fixture.investment_position_snapshots
    .filter((snapshot) => snapshot.date >= startDate && sourceIds.has(snapshot.account_id))
    .map((snapshot) => {
      const target = targetAccounts.get(snapshot.account_id);
      const key = snapshot.kind === 'account'
        ? target.plaid_account_id
        : targetPositions.get(snapshot.key)?.id;
      if (!key) return null;
      return {
        ...snapshot,
        key,
        account_id: target.plaid_account_id,
        item_id: item.id,
        demo: false,
        development_mock: true
      };
    })
    .filter(Boolean);
  store.investment_position_snapshots.push(...copiedSnapshots);
  store.investment_position_snapshots.sort((left, right) => String(left.date).localeCompare(String(right.date)));

  // The development fixture deliberately exercises cash, cards, loans, and
  // provider-defined accounts too. These are clearly marked test records,
  // but use the same daily ledger contract as production detail sheets.
  store.account_balance_snapshots = (store.account_balance_snapshots || [])
    .filter((snapshot) => !targetAccountIds.has(snapshot.account_id));
  const nonInvestmentAccounts = [...targetAccounts.values()].filter((account) => account.type !== 'investment');
  const today = new Date();
  for (let offset = 365; offset >= 0; offset -= 1) {
    const date = new Date(today); date.setDate(today.getDate() - offset);
    const progress = (365 - offset) / 365;
    for (const account of nonInvestmentAccounts) {
      const end = Math.abs(Number(account.current_balance || 0));
      const start = account.type === 'loan' ? end * 1.2 : account.type === 'credit' ? Math.max(0, end * .72) : end * .76;
      // Small, deterministic variation makes range and density states useful
      // without creating sharp, alarming test-data jumps.
      const variation = Math.sin((365 - offset) * .13 + end) * Math.max(4, end * .012);
      const value = Math.max(0, Math.round((start + (end - start) * progress + variation) * 100) / 100);
      store.account_balance_snapshots.push({ date: date.toISOString().slice(0, 10), account_id: account.plaid_account_id, value, source: 'verified', development_mock: true });
    }
  }

  // For a mock-only test profile, build daily net-worth rows from the same
  // copied account snapshot ledger. The dashboard, chart, and account detail
  // therefore reconcile instead of each reading a separate canned series.
  const mockOnlyProfile = (store.accounts || []).every((account) => account.item_id === item.id);
  if (mockOnlyProfile) {
    const investmentByDate = new Map();
    for (const snapshot of copiedSnapshots) {
      if (snapshot.kind !== 'account') continue;
      investmentByDate.set(snapshot.date, (investmentByDate.get(snapshot.date) || 0) + Math.abs(Number(snapshot.value || 0)));
    }
    const balancesByDate = new Map();
    for (const snapshot of store.account_balance_snapshots) {
      if (!targetAccountIds.has(snapshot.account_id)) continue;
      if (!balancesByDate.has(snapshot.date)) balancesByDate.set(snapshot.date, { cash: 0, debt: 0 });
      const account = [...targetAccounts.values()].find((entry) => entry.plaid_account_id === snapshot.account_id);
      if (account?.type === 'depository' || account?.type === 'other') balancesByDate.get(snapshot.date).cash += Math.abs(Number(snapshot.value || 0));
      if (account?.type === 'credit' || account?.type === 'loan') balancesByDate.get(snapshot.date).debt += Math.abs(Number(snapshot.value || 0));
    }
    store.snapshots = [...investmentByDate.entries()].map(([date, investments]) => ({
      date,
      assets: Math.round(((balancesByDate.get(date)?.cash || 0) + investments) * 100) / 100,
      liabilities: balancesByDate.get(date)?.debt || 0,
      net_worth: Math.round((((balancesByDate.get(date)?.cash || 0) + investments) - (balancesByDate.get(date)?.debt || 0)) * 100) / 100,
      source: 'verified',
      development_mock: true
    })).sort((left, right) => left.date.localeCompare(right.date));
    store.investment_snapshots = [...investmentByDate.entries()].map(([date, value]) => ({
      date,
      value: Math.round(value * 100) / 100,
      source: 'verified',
      development_mock: true
    })).sort((left, right) => left.date.localeCompare(right.date));
  }
}

function addDevelopmentMockInstitution(store) {
  const existing = store.items.find((item) => item.development_mock);
  if (existing) {
    seedDevelopmentMockHistory(store, existing, demoPreviewStore());
    return { item: existing, alreadyLinked: true };
  }

  const fixture = demoPreviewStore();
  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    institution_name: 'Clarity Test Bank',
    institution_id: 'clarity-development-mock',
    created_at: now,
    last_synced_at: now,
    last_verified_update_at: now,
    development_mock: true,
    demo: false
  };
  // The development fixture is intentionally dense: it covers every current
  // Plaid account family represented by Clarity, multiple accounts per group,
  // investment holdings, cards, a loan, and a provider-defined account.
  const sourceAccounts = fixture.accounts.map((account) => ({ ...account }));
  sourceAccounts.push({ id: 'development-other', plaid_account_id: 'development-other', institution_name: 'Clarity Test Bank', name: 'Rewards balance', type: 'other', subtype: 'other', current_balance: 375, updated_at: now, demo: true });
  const accountIds = new Map();
  for (const source of sourceAccounts) accountIds.set(source.id, crypto.randomUUID());
  store.items.push(item);
  store.accounts.push(...sourceAccounts.map((source) => ({
    ...source,
    id: accountIds.get(source.id),
    item_id: item.id,
    plaid_account_id: `development-mock-${source.plaid_account_id}`,
    institution_name: item.institution_name,
    updated_at: now,
    demo: false
  })));
  store.positions.push(...fixture.positions
    .filter((position) => accountIds.has(position.account_id))
    .map((position) => ({ ...position, id: crypto.randomUUID(), item_id: item.id, account_id: accountIds.get(position.account_id), demo: false })));
  store.transactions.push(...fixture.transactions.map((transaction) => ({
    ...transaction,
    id: crypto.randomUUID(),
    plaid_transaction_id: `development-mock-${transaction.plaid_transaction_id || transaction.id}`,
    item_id: item.id,
    account_id: accountIds.get(transaction.account_id) || accountIds.get('demo-checking'),
    demo: false
  })));
  seedDevelopmentMockHistory(store, item, fixture);
  hideDuplicateAccounts(store);
  snapshotNetWorth(store);
  snapshotInvestments(store);
  return { item, alreadyLinked: false };
}

function readCookie(req, name) {
  const entry = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function encodeSession(payload) {
  // An HMAC-only cookie kept the email address readable to anyone holding the
  // cookie. AES-GCM provides confidentiality and integrity while preserving
  // the stateless, bounded session design.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionSecret, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function verifySession(req) {
  const value = readCookie(req, 'clarity_session');
  if (!value) return null;
  try {
    const [version, iv, tag, encrypted] = value.split('.');
    if (version !== 'v2' || !iv || !tag || !encrypted) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionSecret, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8'));
    if (typeof payload.email !== 'string' || payload.email.length > 320 || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    const email = payload.email.trim().toLowerCase();
    if (!email) return null;
    return { email, name: String(payload.name || ''), storageKey: userStorageKey(email) };
  } catch { return null; }
}

function setSession(res, user) {
  const value = encodeSession({ email: user.email, name: user.name, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  res.cookie('clarity_session', value, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' });
}

function authConfigured() {
  return Boolean(securityReady() && process.env.GOOGLE_CLIENT_ID && dataEncryptionSecret && dataEncryptionSecret !== 'development-only-key-change-me' && inviteCodeHash);
}

function inviteCodeMatches(value) {
  if (!inviteCodeHash || typeof value !== 'string') return false;
  const suppliedHash = crypto.createHash('sha256').update(value.trim()).digest();
  return crypto.timingSafeEqual(inviteCodeHash, suppliedHash);
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
    last_verified_update_at: item.last_verified_update_at || null,
    last_sync_attempt_at: item.last_sync_attempt_at || null,
    requires_reconnect: Boolean(item.requires_reconnect),
    demo: item.demo || false,
    development_mock: Boolean(item.development_mock)
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
      type: account.type === 'brokerage' ? 'investment' : account.type,
      subtype: account.subtype,
      current_balance: account.balances?.current ?? account.balances?.available ?? 0,
      available_balance: account.balances?.available ?? null,
      limit: account.balances?.limit ?? null,
      iso_currency_code: account.balances?.iso_currency_code || 'USD',
      updated_at: new Date().toISOString(),
      demo: false
    };
    if (existing) Object.assign(existing, normalized);
    else {
      store.accounts.push(normalized);
      if (account.type === 'investment') {
        store.investment_link_events ||= [];
        store.investment_link_events.push({ account_id: account.account_id, date: new Date().toISOString().slice(0, 10), amount: Math.abs(Number(normalized.current_balance || 0)) });
      }
    }
  }

  const types = new Set((data.accounts || []).map((a) => a.type));
  if (types.has('investment')) {
    item.investment_holdings_sync_id = null;
    try {
      const holdingsData = await plaidPost('/investments/holdings/get', { access_token });
      const syncId = crypto.randomUUID();
      item.investment_holdings_sync_id = syncId;
      for (const reported of holdingsData.accounts || []) {
        const account = store.accounts.find((row) => row.plaid_account_id === reported.account_id);
        if (!account) continue;
        account.investment_balance_anchor = { date: new Date().toISOString().slice(0, 10), sync_id: syncId,
          balance: reported.balances?.current, iso_currency_code: reported.balances?.iso_currency_code,
          unofficial_currency_code: reported.balances?.unofficial_currency_code || null };
      }
      const securities = new Map((holdingsData.securities || []).map((security) => [security.security_id, security]));
      store.positions = (store.positions || []).filter((position) => position.item_id !== item.id);
      for (const holding of holdingsData.holdings || []) {
        const security = securities.get(holding.security_id) || {};
        const id = `${item.id}:${holding.account_id}:${holding.security_id}`;
        const historical = historicalSecurity({ ticker: security.ticker_symbol, name: security.name, type: security.type || 'other' });
        store.positions.push({
          id,
          item_id: item.id, account_id: holding.account_id, security_id: holding.security_id,
          name: security.name || holding.security_id, ticker: historical.ticker,
          provider_ticker: String(security.ticker_symbol || '').trim().toUpperCase(),
          iso_currency_code: holding.iso_currency_code, unofficial_currency_code: holding.unofficial_currency_code || null,
          price_as_of: holding.institution_price_as_of || null,
          type: historical.type, asset_class_override: store.position_overrides?.[id] || null, quantity: holding.quantity == null ? null : Number(holding.quantity),
          price: holding.institution_price == null ? null : Number(holding.institution_price), value: holding.institution_value == null ? null : Number(holding.institution_value),
          cost_basis: holding.cost_basis == null ? null : Number(holding.cost_basis), updated_at: new Date().toISOString(), demo: false
        });
      }
    } catch (e) { logOperationalError('Investments not available', e); }
  }
  if (types.has('credit') || types.has('loan')) {
    try {
      const liabilities = await plaidPost('/liabilities/get', { access_token });
      // Rates are useful for a payoff recommendation. Never invent one when
      // an institution does not provide it.
      const records = [
        ...(liabilities.liabilities?.credit || []),
        ...(liabilities.liabilities?.mortgage || []),
        ...(liabilities.liabilities?.student || [])
      ];
      for (const record of records) {
        const account = store.accounts.find((entry) => entry.plaid_account_id === record.account_id);
        if (!account) continue;
        const aprs = Array.isArray(record.aprs) ? record.aprs : [];
        const preferred = aprs.find((apr) => /purchase|interest|variable|fixed/i.test(String(apr.apr_type || ''))) || aprs[0];
        const rate = Number(preferred?.apr_percentage);
        if (account.interest_rate_source !== 'manual' && Number.isFinite(rate) && rate >= 0 && rate <= 100) {
          account.interest_rate = rate;
          account.interest_rate_source = 'institution';
        }
        const minimum = Number(record.minimum_payment_amount);
        if (Number.isFinite(minimum) && minimum >= 0) account.minimum_payment = minimum;
      }
    } catch (e) { logOperationalError('Liabilities not available', e); }
  }
}

// Keep automated refreshes serial per person. A Plaid webhook and the daily
// refresh can otherwise read the same encrypted store concurrently and let an
// older write overwrite a newer one.
function queueUserSync(storageKey, task) {
  const previous = userSyncQueues.get(storageKey) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  userSyncQueues.set(storageKey, next);
  return next.finally(() => {
    if (userSyncQueues.get(storageKey) === next) userSyncQueues.delete(storageKey);
  });
}

function markItemSyncFailure(item, error) {
  item.last_sync_error_at = new Date().toISOString();
  item.last_sync_error_code = String(error?.plaid?.error_code || '');
  item.requires_reconnect = item.last_sync_error_code === 'ITEM_LOGIN_REQUIRED';
  item.sync_failure_count = Number(item.sync_failure_count || 0) + 1;
}

async function syncItem(store, item) {
  item.last_sync_attempt_at = new Date().toISOString();
  try {
    await hydrateInstitutionBrand(item);
    await refreshAccountsForItem(store, item);
    // A successful accounts response is the verified point-in-time update
    // behind balances, holdings, and connection recency. It is intentionally
    // recorded before optional transactions/price enrichment below.
    item.last_verified_update_at = new Date().toISOString();
    // Transaction availability can lag a connection or institution update.
    // Keep a successful balance refresh instead of failing the entire item.
    try { await syncTransactionsForItem(store, item); } catch (error) { logOperationalError('Transactions sync failed', error); }
    // Investments was historically consented in Link, then added on demand. Ask
    // Plaid to prepare the initial extraction asynchronously once, rather than
    // blocking a newly connected account for up to two minutes or silently
    // settling for a connection-day balance. A HISTORICAL_UPDATE webhook will
    // re-enter this sync once the provider has finished preparing its records.
    const hasInvestmentAccount = store.accounts.some((account) => account.item_id === item.id && account.type === 'investment');
    try {
      await syncRetirementContributionsForItem(store, item, {
        asyncUpdate: hasInvestmentAccount && !item.investment_history_requested_at
      });
    } catch (error) { logOperationalError('Investment contribution sync unavailable', error); }
    if (hasInvestmentAccount) {
      try { await hydrateInvestmentPriceHistory(store, item); }
      catch (error) { logOperationalError('Investment price history unavailable', error); }
    }
    item.last_synced_at = new Date().toISOString();
    delete item.last_sync_error_at;
    delete item.last_sync_error_code;
    delete item.requires_reconnect;
    delete item.sync_failure_count;
  } catch (error) {
    markItemSyncFailure(item, error);
    throw error;
  }
}

async function syncStoreItems(store) {
  const results = [];
  for (const item of store.items.filter((candidate) => !candidate.demo && !candidate.development_mock)) {
    try {
      await syncItem(store, item);
      results.push({ item: item.institution_name, ok: true });
    } catch (error) {
      logOperationalError('Account refresh failed for a connected institution', error);
      results.push({ item: item.institution_name, ok: false });
    }
  }
  hideDuplicateAccounts(store);
  snapshotNetWorth(store);
  snapshotInvestments(store);
  return results;
}

async function scheduledDailySync() {
  let storageKeys = listUserStorageKeys();
  if (databaseEnabled()) {
    try { storageKeys = [...new Set([...storageKeys, ...(await listDatabaseStoreKeys())])]; }
    catch (error) { logOperationalError('Daily sync could not enumerate secure stores', error, 'error'); return; }
  }
  for (const storageKey of storageKeys) {
    await queueUserSync(storageKey, async () => {
      try {
        const store = await loadStoreByKey(storageKey);
        if (!store.items.some((item) => !item.demo && !item.development_mock)) return;
        const results = await syncStoreItems(store);
        await saveStoreByKey(storageKey, store);
        trackLaunchEvent({ storageKey }, results.some((result) => result.ok) ? 'sync_succeeded' : 'sync_failed');
      } catch (error) {
        // One person's unavailable institution or store must never block the
        // rest of the daily queue. Existing encrypted data stays intact.
        logOperationalError('Daily sync failed for a financial store', error, 'error');
        trackLaunchEvent({ storageKey }, 'sync_failed');
      }
    });
  }
}

// A person should not have to discover an investment-history setting after
// they connect. On boot, request Plaid's one-time asynchronous extraction for
// legacy Items that predate this behavior. This is deliberately narrower than
// a full account sync: it only touches Items with an already-known investment
// account and only once per Item.
async function requestPendingInvestmentHistory() {
  let storageKeys = listUserStorageKeys();
  if (databaseEnabled()) storageKeys = [...new Set([...storageKeys, ...(await listDatabaseStoreKeys())])];
  for (const storageKey of storageKeys) {
    await queueUserSync(storageKey, async () => {
      const store = await loadStoreByKey(storageKey);
      let changed = false;
      for (const item of store.items.filter((candidate) => !candidate.demo && !candidate.development_mock)) {
        const hasInvestmentAccount = store.accounts.some((account) => account.item_id === item.id && account.type === 'investment');
        try {
          // Upgrade existing connections automatically. Mark the attempt first
          // so an unavailable product cannot cause a full replay every poll.
          const hasCashOrCredit = store.accounts.some((account) => account.item_id === item.id && ['depository', 'credit'].includes(account.type));
          const needsEvidence = (hasCashOrCredit && item.transactions_history_version !== 1) || (hasInvestmentAccount && !item.investment_ledger);
          const lastUpgrade = Date.parse(item.history_upgrade_attempted_at || '') || 0;
          if (needsEvidence && Date.now() - lastUpgrade >= 24 * 60 * 60_000) {
            item.history_upgrade_attempted_at = new Date().toISOString();
            changed = true;
            await syncItem(store, item);
          }
          if (!hasInvestmentAccount) continue;
          if (!item.investment_history_requested_at) {
            await syncRetirementContributionsForItem(store, item, { asyncUpdate: true });
            changed = true;
          }
          // `HISTORICAL_UPDATE` normally arrives when Plaid finishes, but a
          // webhook can be delayed or unavailable. A bounded, per-Item poll
          // lets every connected person receive ready history promptly without
          // exposing a manual sync control or repeatedly hitting Plaid.
          const lastChecked = new Date(item.investment_history_last_checked_at || item.investment_history_requested_at || 0).getTime();
          if (item.investment_history_state === 'preparing'
            && Number(item.investment_history_poll_attempts || 0) < MAX_INVESTMENT_HISTORY_RETRY_ATTEMPTS
            && (!Number.isFinite(lastChecked) || Date.now() - lastChecked >= INVESTMENT_HISTORY_RETRY_MS)) {
            await syncRetirementContributionsForItem(store, item);
            changed = true;
          }
          if (item.investment_history_state === 'ready') {
            await hydrateInvestmentPriceHistory(store, item);
            changed = true;
          }
        } catch (error) {
          // A provider issue must not block startup or prevent other people
          // from receiving the request. The normal daily sync will retry it.
          logOperationalError('Investment history request unavailable', error);
        }
      }
      if (changed) await saveStoreByKey(storageKey, store);
    });
  }
}

function scheduleInvestmentHistoryRetries() {
  const retry = () => requestPendingInvestmentHistory().catch((error) => logOperationalError('Investment history retry failed', error, 'error'));
  const interval = setInterval(retry, INVESTMENT_HISTORY_RETRY_MS);
  interval.unref?.();
}

function millisecondsUntilDailySync() {
  const now = new Date();
  const next = new Date(now);
  // Quiet off-peak window. Webhooks still refresh changes sooner; this is the
  // guaranteed daily catch-up.
  next.setUTCHours(10, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailySync() {
  const delay = Math.min(millisecondsUntilDailySync(), DAILY_SYNC_INTERVAL_MS);
  const first = setTimeout(() => {
    scheduledDailySync().catch((error) => logOperationalError('Daily sync scheduler failed', error, 'error'));
    const interval = setInterval(() => scheduledDailySync().catch((error) => logOperationalError('Daily sync scheduler failed', error, 'error')), DAILY_SYNC_INTERVAL_MS);
    interval.unref?.();
  }, delay);
  first.unref?.();
}

// Deployments can happen immediately after someone connects an account. Cover
// that short handoff by recording a baseline for recently linked investment
// accounts that predate this field, without reclassifying older history.
function backfillRecentInvestmentLinkBalances(store) {
  const cutoff = Date.now() - 7 * 86400000;
  store.investment_link_events ||= [];
  for (const account of store.accounts || []) {
    if (account.type !== 'investment' || store.investment_link_events.some((event) => event.account_id === account.plaid_account_id)) continue;
    const item = (store.items || []).find((candidate) => candidate.id === account.item_id);
    const linkedAt = new Date(item?.created_at || 0);
    if (!Number.isFinite(linkedAt.getTime()) || linkedAt.getTime() < cutoff) continue;
    store.investment_link_events.push({ account_id: account.plaid_account_id, date: linkedAt.toISOString().slice(0, 10), amount: Math.abs(Number(account.current_balance || 0)) });
  }
}

// A connection-day balance is not performance. Mark it as historically covered
// only when every holding in that individual account has a real pre-link price
// record. Cash or unpriced positions deliberately remain uncovered: assuming
// today's balance existed in the past would make growth look better than it was.
function markInvestmentLinkCoverage(store) {
  const positionsByAccount = new Map();
  for (const position of store.positions || []) {
    if (!positionsByAccount.has(position.account_id)) positionsByAccount.set(position.account_id, []);
    positionsByAccount.get(position.account_id).push(position);
  }
  for (const event of store.investment_link_events || []) {
    const positions = positionsByAccount.get(event.account_id) || [];
    event.historical_coverage = positions.length > 0 && positions.every((position) => {
      if (position.type === 'cash' || !position.ticker) return false;
      return Object.keys(store.market_prices?.[position.ticker] || {}).some((date) => date < event.date);
    });
  }
}

// Upgrade previously synced transactions as the attribution model evolves.
// This makes historical contribution data useful immediately, without asking
// people to unlink/relink accounts or wait for a new transaction cursor.
function backfillInvestmentContributionMetadata(store) {
  for (const transaction of store.transactions || []) {
    if (Number(transaction.investment_contribution_amount || 0) > 0) continue;
    const sourceAccount = store.accounts.find((account) => account.plaid_account_id === transaction.account_id);
    if (sourceAccount?.type === 'investment' && Number(transaction.amount || 0) < 0) {
      transaction.investment_contribution_amount = Math.abs(Number(transaction.amount || 0));
      transaction.investment_contribution_account_id = sourceAccount.plaid_account_id;
      continue;
    }
    const target = plannedTransferTarget(store, transaction, 'transfer');
    if (target?.bucket === 'investments' && Number(transaction.amount || 0) > 0) {
      transaction.investment_contribution_amount = Number(transaction.amount || 0);
      transaction.investment_contribution_account_id = target.accountId;
    }
  }
}

async function syncTransactionsForItem(store, item) {
  const access_token = decrypt(item.access_token_enc);
  // Replay once to retain currency/balance evidence for previously linked
  // accounts. User categorization is preserved by the normal upsert path.
  let cursor = item.transactions_history_version === 1 ? item.cursor || undefined : undefined;
  const originalStore = store;
  store = { ...store, transactions: store.transactions.map((row) => ({ ...row })) };
  const balances = new Map();
  let historyComplete = false;
  let hasMore = true;
  while (hasMore) {
    const data = await plaidPost('/transactions/sync', { access_token, cursor, count: 500, options: { include_personal_finance_category: true } });
    historyComplete ||= data.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE';
    for (const account of data.accounts || []) balances.set(account.account_id, account.balances);
    const changes = [...(data.added || []), ...(data.modified || [])];
    for (const transaction of changes) {
      const existing = store.transactions.find((record) => record.plaid_transaction_id === transaction.transaction_id);
      const baseBucket = classifyTransaction(transaction);
      const transferTarget = plannedTransferTarget(store, transaction, baseBucket);
      const sourceAccount = store.accounts.find((account) => account.plaid_account_id === transaction.account_id);
      // Plaid records a deposit into an investment account as a negative
      // transaction. Preserve its original signed amount, but retain a
      // dedicated contribution value so it can be separated from performance.
      const contributionAmount = sourceAccount?.type === 'investment' && Number(transaction.amount || 0) < 0
        ? Math.abs(Number(transaction.amount || 0))
        : transferTarget?.bucket === 'investments' && Number(transaction.amount || 0) > 0 ? Number(transaction.amount || 0) : null;
      const normalized = {
        id: existing?.id || crypto.randomUUID(), item_id: item.id, plaid_transaction_id: transaction.transaction_id,
        account_id: transaction.account_id, merchant_name: transaction.merchant_name, name: transaction.name,
        amount: transaction.amount, date: transaction.date, bucket: existing?.category_overridden ? existing.bucket : (transferTarget?.bucket || baseBucket), cash_flow_type: cashFlowType(transaction), investment_contribution_amount: contributionAmount, investment_contribution_account_id: sourceAccount?.type === 'investment' ? sourceAccount.plaid_account_id : transferTarget?.accountId || null, excluded: existing?.excluded || false,
        iso_currency_code: transaction.iso_currency_code, unofficial_currency_code: transaction.unofficial_currency_code || null,
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
  originalStore.transactions = store.transactions;
  item.transactions_history_version = 1;
  item.transactions_history_complete = historyComplete || item.transactions_history_complete === true;
  originalStore.account_balance_snapshots ||= [];
  for (const account of originalStore.accounts.filter((row) => row.item_id === item.id && row.type !== 'investment' && !row.manual)) {
    const balance = balances.get(account.plaid_account_id);
    if (balance?.current == null || !Number.isFinite(Number(balance.current))) continue;
    const date = new Date().toISOString().slice(0, 10);
    account.transaction_balance_anchor = { date, balance: Number(balance.current), iso_currency_code: balance.iso_currency_code, unofficial_currency_code: balance.unofficial_currency_code || null };
    const row = { date, account_id: account.plaid_account_id, value: Number(balance.current), source: 'verified' };
    const existing = originalStore.account_balance_snapshots.find((snapshot) => snapshot.date === date && snapshot.account_id === account.plaid_account_id);
    if (existing) Object.assign(existing, row); else originalStore.account_balance_snapshots.push(row);
  }
  const cutoff = historyStart(new Date().toISOString().slice(0, 10), 2);
  originalStore.account_balance_snapshots = originalStore.account_balance_snapshots.filter((row) => row.date >= cutoff);
  item.cursor = cursor || item.cursor || null;
}

function plannedTransferTarget(store, transaction, bucket) {
  if (bucket !== 'transfer' || Number(transaction.amount || 0) <= 0) return null;
  const detailed = String(transaction.personal_finance_category?.detailed || transaction.pfc_detailed || '').toUpperCase();
  const destinationBucket = detailed.includes('CREDIT_CARD_PAYMENT') ? null
    : detailed.includes('INVESTMENT') || detailed.includes('RETIREMENT') ? 'investments'
      : detailed.includes('SAVINGS') ? 'savings' : null;
  // Do not guess a destination from a shared brand name. Plaid must identify
  // an investing/savings destination before a transfer can be an allocation.
  if (!destinationBucket) return null;
  const description = `${transaction.merchant_name || ''} ${transaction.name || ''}`.toLowerCase();
  const targets = store.accounts.filter((account) => !account.hidden && (destinationBucket === 'investments' ? account.type === 'investment' : account.type === 'depository' && /savings/i.test(account.subtype || account.name || '')));
  for (const target of targets) {
    const institutionWords = String(target.institution_name || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4);
    const nameWords = String(target.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 5);
    if (![...institutionWords, ...nameWords].some((word) => description.includes(word))) continue;
    return { bucket: destinationBucket, accountId: target.plaid_account_id };
  }
  return { bucket: destinationBucket, accountId: null };
}

function isPlaidProductNotReady(error) {
  return String(error?.plaid?.error_code || '') === 'PRODUCT_NOT_READY';
}

async function syncRetirementContributionsForItem(store, item, { asyncUpdate = false } = {}) {
  const access_token = decrypt(item.access_token_enc);
  const end_date = new Date().toISOString().slice(0, 10);
  const start = new Date();
  start.setFullYear(start.getFullYear() - 2);
  const start_date = start.toISOString().slice(0, 10);
  let imported = 0;
  const accounts = new Map(store.accounts.map((account) => [account.plaid_account_id, account]));
  const hasInvestmentAccount = [...accounts.values()].some((account) => account.item_id === item.id && account.type === 'investment');
  if (!hasInvestmentAccount) return { state: 'not_applicable', imported: 0 };
  store.investment_transactions ||= [];
  item.investment_history_last_checked_at = new Date().toISOString();
  item.investment_ledger = { complete: false };
  try {
      const data = await investmentLedgerPages({
        access_token,
        start_date,
        end_date,
        options: { ...(asyncUpdate ? { async_update: true } : {}) }
      });
      item.investment_history_requested_at ||= new Date().toISOString();
      const canceled = new Set(data.investment_transactions.map((row) => row.cancel_transaction_id).filter(Boolean));
      const active = data.investment_transactions.filter((row) => !row.cancel_transaction_id && !canceled.has(row.investment_transaction_id));
      const activeIds = new Set(active.map((row) => `investment:${row.investment_transaction_id}`));
      store.investment_transactions = store.investment_transactions.filter((row) => row.item_id !== item.id || (row.date < start_date && !canceled.has(row.id)));
      store.transactions = store.transactions.filter((row) => row.item_id !== item.id || row.source !== 'investment_transaction' || (row.date < start_date && !canceled.has(row.plaid_transaction_id?.slice(11))) || activeIds.has(row.plaid_transaction_id));
      const securities = new Map((data.securities || []).map((security) => [security.security_id, security]));
      for (const transaction of active) {
        imported += 1;
        const security = securities.get(transaction.security_id) || {};
        const historical = historicalSecurity({ ticker: security.ticker_symbol, name: security.name, type: security.type || null });
        const investmentId = transaction.investment_transaction_id;
        const existingInvestment = store.investment_transactions.find((record) => record.id === investmentId);
        const recorded = { id: investmentId, item_id: item.id, account_id: transaction.account_id, security_id: transaction.security_id || null, ticker: historical.ticker || null, provider_ticker: String(security.ticker_symbol || '').trim().toUpperCase(), security_name: security.name || null, security_type: historical.type || null, date: transaction.date, quantity: transaction.quantity ?? null, price: transaction.price ?? null, amount: transaction.amount ?? null, fees: transaction.fees ?? null, iso_currency_code: transaction.iso_currency_code, unofficial_currency_code: transaction.unofficial_currency_code || null, type: transaction.type || null, subtype: transaction.subtype || null };
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
  } catch (error) {
    if (isPlaidProductNotReady(error)) {
      item.investment_history_requested_at ||= new Date().toISOString();
      item.investment_history_state = 'preparing';
      if (!asyncUpdate) item.investment_history_poll_attempts = Number(item.investment_history_poll_attempts || 0) + 1;
      return { state: 'preparing', imported: 0 };
    }
    throw error;
  }
  item.investment_history_state = 'ready';
  item.investment_ledger = { complete: true, start_date, end_date, holdings_sync_id: item.investment_holdings_sync_id };
  item.investment_history_received_at = new Date().toISOString();
  delete item.investment_history_poll_attempts;
  return { state: 'ready', imported };
}

// Prices are fetched only for securities in the institution-reported ledger,
// then cached. The reconstruction layer independently verifies the resulting
// timeline against the institution's current value before it can be shown.
async function hydrateInvestmentPriceHistory(store, item) {
  const end = new Date().toISOString().slice(0, 10);
  const requestedStart = new Date();
  requestedStart.setFullYear(requestedStart.getFullYear() - Math.max(1, Math.min(2, Number(process.env.MARKETDATA_HISTORY_YEARS || 1))));
  const start = requestedStart.toISOString().slice(0, 10);
  const securities = new Map();
  for (const position of store.positions || []) {
    if (position.item_id !== item.id || position.type === 'cash' || !position.ticker) continue;
    securities.set(String(position.ticker).toUpperCase(), { ticker: String(position.ticker).toUpperCase(), type: position.type });
  }
  for (const transaction of store.investment_transactions || []) {
    if (transaction.item_id !== item.id || transaction.security_type === 'cash' || !transaction.ticker) continue;
    securities.set(String(transaction.ticker).toUpperCase(), { ticker: String(transaction.ticker).toUpperCase(), type: transaction.security_type });
  }
  store.market_prices ||= {};
  store.market_price_metadata ||= {};
  for (const security of securities.values()) {
    if (!['equity', 'etf', 'mutual fund'].includes(security.type) || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(security.ticker)) continue;
    const cached = store.market_price_metadata[security.ticker]?.basis === 'unadjusted' ? store.market_prices[security.ticker] || {} : {};
    const dates = Object.keys(cached).sort();
    const first = dates[0];
    const latest = dates.at(-1);
    // A complete historical span only needs a short overlapping refresh for
    // recent market sessions. This prevents routine syncs from re-buying a
    // year's worth of candles for every holding.
    const latestAge = latest ? Math.floor((Date.now() - new Date(`${latest}T12:00:00`).getTime()) / 86400000) : Infinity;
    const coveredStart = first && first <= new Date(Date.parse(`${start}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    if (coveredStart && latestAge <= 1) continue;
    if (store.market_price_metadata[security.ticker]?.checked_date === end) continue;
    const from = coveredStart && latest ? new Date(Math.max(new Date(`${latest}T12:00:00`).getTime() - 7 * 86400000, new Date(`${start}T12:00:00`).getTime())).toISOString().slice(0, 10) : start;
    try {
      const prices = await loadHistoricalPrices({ symbol: security.ticker, securityType: security.type, from, to: end });
      if (Object.keys(prices).length) {
        store.market_prices[security.ticker] = { ...cached, ...prices };
        store.market_price_metadata[security.ticker] = { basis: 'unadjusted', provider: 'marketdata', checked_date: end };
      }
    } catch {
      // One missing symbol must not prevent the other accounts from backfilling.
      store.market_price_metadata[security.ticker] = { ...store.market_price_metadata[security.ticker], checked_date: end };
    }
  }
  item.investment_price_history_checked_at = new Date().toISOString();
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
    logOperationalError('Institution brand unavailable', error);
  }
}

app.get('/api/health', async (_req, res) => {
  let databaseReady = true;
  try { await databaseHealthy(); } catch { databaseReady = false; }
  const ok = securityReady() && databaseReady;
  res.status(ok ? 200 : 503).json({ ok, securityReady: securityReady(), databaseReady });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ configured: authConfigured(), googleClientId: authConfigured() ? process.env.GOOGLE_CLIENT_ID : null });
});

app.get('/api/auth/me', (req, res) => {
  const user = verifySession(req);
  if (!user) return res.status(401).json({ error: 'Sign in required.' });
  res.json({ user: publicUser(user) });
});

// This is a convenience gate before opening Google’s account chooser. The
// code is checked again after Google returns a verified identity; this endpoint
// alone never creates a session or grants data access.
app.post('/api/auth/access-code', authLimiter, (req, res) => {
  if (!authConfigured()) return res.status(503).json({ error: 'Sign-in is not configured yet.' });
  if (!inviteCodeMatches(req.body?.inviteCode)) return res.status(403).json({ error: 'This app is invite-only. Enter a valid access code to continue.' });
  res.json({ ok: true });
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const attempts = loginAttempts.get(ip) || [];
  const recent = attempts.filter((time) => time > Date.now() - 10 * 60 * 1000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
  const startedAt = Date.now();
  try {
    if (!authConfigured()) return res.status(503).json({ error: 'Sign-in is not configured yet.' });
    const ticket = await googleClient.verifyIdToken({ idToken: req.body?.credential, audience: process.env.GOOGLE_CLIENT_ID });
    void recordDependencyEvent({ dependency: 'google_oauth', operation: 'verify_id_token', outcome: 'success', durationMs: Date.now() - startedAt }).catch(() => {});
    const payload = ticket.getPayload();
    const email = String(payload?.email || '').toLowerCase();
    if (!payload?.email_verified) return res.status(403).json({ error: 'A verified Google email is required.' });
    if (!inviteCodeMatches(req.body?.inviteCode)) return res.status(403).json({ error: 'This app is invite-only. Enter a valid access code to continue.' });
    loginAttempts.delete(ip);
    const user = { email, name: String(payload.name || '') };
    setSession(res, user);
    await trackLaunchEvent({ storageKey: userStorageKey(email) }, 'sign_in_completed');
    res.json({ ok: true, user: publicUser(user) });
  } catch {
    void recordDependencyEvent({ dependency: 'google_oauth', operation: 'verify_id_token', outcome: 'failure', durationMs: Date.now() - startedAt }).catch(() => {});
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
  trackLaunchEvent(null, 'demo_opened');
  const store = demoPreviewStore();
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(req.query.range) ? req.query.range : '1m';
  res.json({
    dashboard: {
      summary: summarizeRange(store),
      runway: cashRunway(store),
      goals: goalProgress(store), monthlyReview: monthlyReview(store), clarityCheckin: clarityCheckin(store), connectionHealth: connectionHealth(store),
      recurring: recurringCharges(store),
      investmentContributions: investmentContributions(store),
      investmentLinkBalances: investmentLinkBalances(store),
      debtPayoff: debtPayoffPlan(store),
      accounts: store.accounts.filter((account) => !account.hidden).sort((a, b) => Number(b.current_balance || 0) - Number(a.current_balance || 0)),
      snapshots: store.snapshots.slice(-3650),
      items: store.items.map(publicItem),
      plaidConfigured: false,
      demoMode: true
    },
    spending: spendingSummary(store, range),
    investments: investmentSummary(store, { range: 'all' }),
    retirement: calculateFire(store, summarizeRange(store).netWorth)
  });
});

app.get('/api/demo-investments', demoLimiter, (req, res) => {
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  res.json(investmentSummary(demoPreviewStore(), { range }));
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/health' || req.path === '/plaid/webhook' || req.path === '/demo-investments' || req.path === '/demo-investments/history') return next();
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

// Signed-in demo is an in-memory financial scenario. Do not rely only on the
// UI to keep real mutations out of it: a stale tab or crafted request must
// never alter a member's accounts, names, plan, or connections while demo is
// active. The two allowlisted writes are intentionally non-financial: exiting
// demo, and calculating a throwaway retirement preview.
app.use('/api', async (req, res, next) => {
  if (!req.user || !['POST', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (['/demo-mode', '/launch-event', '/retirement/preview'].includes(req.path)) return next();
  try {
    const store = await loadStore(req.user);
    if (store.settings?.demo_mode) return res.status(409).json({ error: 'Exit demo to change your personal financial data.' });
    next();
  } catch (error) {
    logOperationalError('Protected API store check failed', error, 'error');
    res.status(503).json(publicErrorPayload('financial_data_unavailable'));
  }
});

// Background-only product telemetry. The client can submit an allowlisted
// event name and nothing else; values, account metadata, routes, and browser
// identifiers are deliberately not accepted.
app.post('/api/launch-event', async (req, res) => {
  try {
    await recordLaunchEvent(req.user.storageKey, String(req.body?.event || ''));
    res.sendStatus(204);
  } catch {
    res.status(400).json({ error: 'Invalid launch event.' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  const store = await loadStore(req.user);
  const isDemoMode = Boolean(store.settings?.demo_mode);
  // Never backfill or snapshot the persisted account while its owner is
  // looking at demo. Demo has its own seeded history and must be read-only.
  if (!isDemoMode) {
    backfillRecentInvestmentLinkBalances(store);
    backfillInvestmentContributionMetadata(store);
    markInvestmentLinkCoverage(store);
    removeEstimatedNetWorthHistory(store);
    hideDuplicateAccounts(store);
    snapshotNetWorth(store);
    snapshotInvestments(store);
    await saveStore(req.user, store);
  }
  const visibleStore = activeStore(store);
  const summary = summarizeRange(visibleStore);
  const snapshots = (visibleStore.snapshots || []).filter((snapshot) => snapshot.source === 'verified').slice(-3650);
  const accounts = visibleStore.accounts.filter((account) => !account.hidden).sort((a, b) => Number(b.current_balance || 0) - Number(a.current_balance || 0));
  // A persistent Google session does not pass through OAuth again on every
  // visit. Record these minimal markers before replying so the private
  // activation metric includes existing signed-in members.
  await trackLaunchEvent(req.user, 'sign_in_completed');
  await trackLaunchEvent(req.user, 'dashboard_opened');
  res.json({
    user: publicUser(req.user),
    summary,
    runway: cashRunway(visibleStore),
    goals: goalProgress(visibleStore),
    monthlyReview: monthlyReview(visibleStore),
    clarityCheckin: clarityCheckin(visibleStore),
    connectionHealth: connectionHealth(visibleStore),
    recurring: recurringCharges(visibleStore),
    investmentContributions: investmentContributions(visibleStore),
    investmentLinkBalances: investmentLinkBalances(visibleStore),
    debtPayoff: debtPayoffPlan(visibleStore),
    accounts,
    snapshots,
    items: visibleStore.items.map(publicItem),
    plaidConfigured: plaidConfigured(),
    developmentTesting: developmentMockConnectionsEnabled(req),
    demoMode: Boolean(store.settings?.demo_mode) || visibleStore.accounts.some((a) => a.demo),
    appearance: store.settings?.appearance || { theme: 'light' }
  });
});

app.get('/api/spending', async (req, res) => {
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(req.query.range) ? req.query.range : '1m';
  const store = activeStore(await loadStore(req.user));
  res.json(spendingSummary(store, range));
});

app.get('/api/investments', async (req, res) => {
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  const persistedStore = await loadStore(req.user);
  const isDemoMode = Boolean(persistedStore.settings?.demo_mode);
  const store = activeStore(persistedStore);
  // Capture the connection-day baseline. Future successful daily syncs add
  // provider-observed account and holding values—no history is inferred.
  snapshotInvestments(store);
  // Signed-in demo is an in-memory view. Never persist its seeded accounts
  // over a member's real store; the safety boundary would block it anyway,
  // but an error here made demo mode appear as a failed data load.
  if (!isDemoMode) await saveStore(req.user, store);
  res.json(investmentSummary(store, { range }));
});

app.get('/api/investments/history', async (req, res) => {
  const accountId = String(req.query.account_id || '').trim().slice(0, 180);
  const ticker = String(req.query.ticker || '').trim().toUpperCase().slice(0, 24);
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  if (!accountId && !ticker) return res.status(400).json({ error: 'Choose an investment account or holding.' });
  const persistedStore = await loadStore(req.user);
  const isDemoMode = Boolean(persistedStore.settings?.demo_mode);
  const store = activeStore(persistedStore);
  // Opening an account or holding is also a safe opportunity to persist its
  // current provider-observed value. This guarantees a truthful baseline even
  // when the member arrived here before the scheduled daily sync.
  snapshotInvestments(store);
  if (!isDemoMode) await saveStore(req.user, store);
  res.json(investmentDetailHistory(store, { accountId: accountId || null, ticker: ticker || null, range, years: Math.max(1, Math.min(2, Number(process.env.MARKETDATA_HISTORY_YEARS || 1))) }));
});

app.get('/api/demo-investments/history', demoLimiter, (req, res) => {
  const accountId = String(req.query.account_id || '').trim().slice(0, 180);
  const ticker = String(req.query.ticker || '').trim().toUpperCase().slice(0, 24);
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  if (!accountId && !ticker) return res.status(400).json({ error: 'Choose an investment account or holding.' });
  res.json(investmentDetailHistory(demoPreviewStore(), { accountId: accountId || null, ticker: ticker || null, range, years: 1 }));
});

app.get('/api/accounts/history', async (req, res) => {
  const accountId = String(req.query.account_id || '').trim().slice(0, 180);
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  if (!accountId) return res.status(400).json({ error: 'Choose a connected account.' });
  const store = activeStore(await loadStore(req.user));
  const detail = accountBalanceHistory(store, { accountId, range });
  if (!detail) return res.status(404).json({ error: 'This account history is unavailable.' });
  res.json(detail);
});

app.get('/api/demo-accounts/history', demoLimiter, (req, res) => {
  const accountId = String(req.query.account_id || '').trim().slice(0, 180);
  const range = ['1m', '3m', '6m', 'ytd', '1y', 'all'].includes(String(req.query.range || '')) ? String(req.query.range) : 'all';
  if (!accountId) return res.status(400).json({ error: 'Choose a connected account.' });
  const detail = accountBalanceHistory(demoPreviewStore(), { accountId, range });
  if (!detail) return res.status(404).json({ error: 'This account history is unavailable.' });
  res.json(detail);
});

app.get('/api/retirement', async (req, res) => {
  const store = activeStore(await loadStore(req.user));
  res.json(calculateFire(store, summarizeRange(store).netWorth));
});

function retirementSettingsFrom(body, existing = {}) {
  const fields = ['age', 'retirement_age', 'withdrawal_rate', 'real_return', 'lean_multiplier', 'fat_multiplier'];
  const limits = {
    age: [18, 100],
    retirement_age: [19, 100],
    withdrawal_rate: [0, 20],
    real_return: [0, 15]
  };
  const settings = { ...existing };
  for (const field of fields) {
    if (body?.[field] === undefined) continue;
    const value = Number(body[field]);
    if (!Number.isFinite(value)) throw new Error(`Invalid ${field}.`);
    const range = limits[field];
    if (range && (value < range[0] || value > range[1])) throw new Error(`${field.replace('_', ' ')} must be between ${range[0]} and ${range[1]}.`);
    settings[field] = value;
  }
  if (Number(settings.retirement_age) < Number(settings.age)) throw new Error('Retirement age must be after current age.');
  return settings;
}

app.post('/api/retirement/preview', async (req, res) => {
  try {
    const store = activeStore(await loadStore(req.user));
    store.settings ||= {};
    store.settings.fire = retirementSettingsFrom(req.body, store.settings.fire);
    res.json(calculateFire(store, summarizeRange(store).netWorth));
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.patch('/api/settings/retirement', async (req, res) => {
  const store = await loadStore(req.user);
  try { store.settings.fire = retirementSettingsFrom(req.body, store.settings.fire); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  store.settings.fire.assumptions_configured = true;
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
    catch (error) { logOperationalError('Plaid connection revocation skipped', error); }
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

app.patch('/api/settings/debt-strategy', async (req, res) => {
  const strategy = String(req.body?.strategy || '');
  if (!['avalanche', 'snowball'].includes(strategy)) return res.status(400).json({ error: 'Choose a debt payoff approach.' });
  const store = await loadStore(req.user);
  store.settings ||= {};
  store.settings.debt_strategy = strategy;
  await saveStore(req.user, store);
  res.json(debtPayoffPlan(activeStore(store)));
});

app.patch('/api/accounts/:id/debt-details', async (req, res) => {
  const rawRate = req.body?.interest_rate;
  const interestRate = rawRate === '' || rawRate == null ? null : Number(rawRate);
  if (interestRate != null && (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100)) return res.status(400).json({ error: 'Enter an annual rate from 0% to 100%.' });
  const store = await loadStore(req.user);
  const account = store.accounts.find((record) => record.id === req.params.id && !record.demo && ['credit', 'loan'].includes(String(record.type || '').toLowerCase()));
  if (!account) return res.status(404).json({ error: 'Debt account not found.' });
  // A manual value is deliberately preserved across provider refreshes until
  // the person clears it, since not every bank shares liabilities metadata.
  account.interest_rate = interestRate;
  account.interest_rate_source = interestRate == null ? null : 'manual';
  await saveStore(req.user, store);
  res.json(debtPayoffPlan(activeStore(store)));
});

app.post('/api/manual-accounts', async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const kind = String(req.body?.kind || 'asset');
  const value = Number(req.body?.value);
  const subtype = String(req.body?.subtype || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) return res.status(400).json({ error: 'Enter a name of 60 characters or fewer.' });
  if (!['asset', 'liability'].includes(kind)) return res.status(400).json({ error: 'Choose an asset or debt.' });
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Enter a value of $0 or more.' });
  const store = await loadStore(req.user);
  const id = crypto.randomUUID();
  store.accounts.push({ id, plaid_account_id: `manual:${id}`, item_id: null, institution_name: 'Manual', name, nickname: null, type: kind === 'liability' ? 'loan' : 'other', subtype: subtype || (kind === 'liability' ? 'Other debt' : 'Other asset'), current_balance: Math.round(value * 100) / 100, available_balance: null, limit: null, iso_currency_code: 'USD', updated_at: new Date().toISOString(), manual: true, demo: false });
  snapshotNetWorth(store);
  await saveStore(req.user, store);
  res.json({ ok: true });
});

app.patch('/api/manual-accounts/:id', async (req, res) => {
  const store = await loadStore(req.user);
  const account = store.accounts.find((record) => record.id === req.params.id && record.manual && !record.demo);
  if (!account) return res.status(404).json({ error: 'Manual item not found.' });
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const value = Number(req.body?.value);
  if (!name || name.length > 60 || !Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'Enter a valid name and value.' });
  account.name = name; account.subtype = String(req.body?.subtype || account.subtype || '').trim().slice(0, 60); account.current_balance = Math.round(value * 100) / 100; account.updated_at = new Date().toISOString();
  snapshotNetWorth(store);
  await saveStore(req.user, store);
  res.json({ ok: true });
});

app.delete('/api/manual-accounts/:id', async (req, res) => {
  const store = await loadStore(req.user);
  const account = store.accounts.find((record) => record.id === req.params.id && record.manual && !record.demo);
  if (!account) return res.status(404).json({ error: 'Manual item not found.' });
  store.accounts = store.accounts.filter((record) => record.id !== account.id);
  snapshotNetWorth(store);
  await saveStore(req.user, store);
  res.json({ ok: true });
});

app.post('/api/goals', async (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const source = String(req.body?.source || 'cash');
  const target = Number(req.body?.target);
  if (!name || name.length > 60 || !['cash', 'investments', 'net_worth', 'debt'].includes(source) || !Number.isFinite(target) || target <= 0) return res.status(400).json({ error: 'Enter a name, source, and target greater than $0.' });
  const store = await loadStore(req.user);
  store.settings.goals ||= [];
  if (store.settings.goals.length >= 1) return res.status(400).json({ error: 'Keep one active goal so your plan stays focused.' });
  store.settings.goals.push({ id: crypto.randomUUID(), name, source, target: Math.round(target * 100) / 100, created_at: new Date().toISOString() });
  await saveStore(req.user, store);
  res.json({ ok: true });
  trackLaunchEvent(req.user, 'goal_created');
});

app.delete('/api/goals/:id', async (req, res) => {
  const store = await loadStore(req.user);
  const before = (store.settings.goals || []).length;
  store.settings.goals = (store.settings.goals || []).filter((goal) => goal.id !== req.params.id);
  if (store.settings.goals.length === before) return res.status(404).json({ error: 'Goal not found.' });
  await saveStore(req.user, store);
  res.json({ ok: true });
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

const holdingAssetClasses = new Set(['Equities', 'Funds', 'Fixed income', 'Cash', 'Crypto', 'Other']);

app.post('/api/investment-accounts/:id/manual-holdings', async (req, res) => {
  const ticker = String(req.body?.ticker || '').trim().replace(/\s+/g, ' ').toUpperCase();
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const assetClass = String(req.body?.asset_class || '').trim();
  const value = Number(req.body?.value);
  if ((!ticker && !name) || ticker.length > 24 || name.length > 80) return res.status(400).json({ error: 'Enter a security name or ticker within the allowed length.' });
  if (!holdingAssetClasses.has(assetClass)) return res.status(400).json({ error: 'Choose an asset type.' });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'Enter a current value greater than $0.' });
  const store = await loadStore(req.user);
  const account = store.accounts.find((record) => record.plaid_account_id === req.params.id && record.type === 'investment' && !record.hidden && !record.demo);
  if (!account) return res.status(404).json({ error: 'Investment account not found.' });
  const reportedValue = (store.positions || []).filter((position) => position.account_id === account.plaid_account_id && !position.hidden).reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  const manualValue = (store.manual_holdings || []).filter((position) => position.account_id === account.plaid_account_id).reduce((sum, position) => sum + Math.abs(Number(position.value || 0)), 0);
  const remaining = Math.max(0, Math.abs(Number(account.current_balance || 0)) - reportedValue - manualValue);
  if (value > remaining + 0.01) return res.status(400).json({ error: `This is more than the ${remaining.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} not represented by returned holdings.` });
  store.manual_holdings ||= [];
  store.manual_holdings.push({ id: `manual:${crypto.randomUUID()}`, account_id: account.plaid_account_id, ticker, name: name || ticker, asset_class: assetClass, value: Math.round(value * 100) / 100, created_at: new Date().toISOString() });
  await saveStore(req.user, store);
  res.json(investmentSummary(activeStore(store)));
});

app.delete('/api/manual-holdings/:id', async (req, res) => {
  const store = await loadStore(req.user);
  const index = (store.manual_holdings || []).findIndex((position) => position.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Manual holding not found.' });
  store.manual_holdings.splice(index, 1);
  await saveStore(req.user, store);
  res.json(investmentSummary(activeStore(store)));
});

app.patch('/api/manual-holdings/:id/asset-class', async (req, res) => {
  const assetClass = String(req.body?.asset_class || '').trim();
  if (!holdingAssetClasses.has(assetClass)) return res.status(400).json({ error: 'Choose an asset type.' });
  const store = await loadStore(req.user);
  const position = (store.manual_holdings || []).find((record) => record.id === req.params.id);
  if (!position) return res.status(404).json({ error: 'Manual holding not found.' });
  position.asset_class = assetClass;
  await saveStore(req.user, store);
  res.json(investmentSummary(activeStore(store)));
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
  if (!item.development_mock) {
    try { await plaidPost('/item/remove', { access_token: decrypt(item.access_token_enc) }); }
    catch (error) {
      logOperationalError('Plaid connection revocation failed', error);
      return res.status(503).json({ error: 'We could not unlink this institution yet. Please try again shortly.' });
    }
  }
  store.items = store.items.filter((candidate) => candidate.id !== item.id);
  store.accounts = store.accounts.filter((account) => account.item_id !== item.id);
  store.positions = (store.positions || []).filter((position) => position.item_id !== item.id);
  const remainingAccountIds = new Set(store.accounts.map((account) => account.plaid_account_id));
  store.manual_holdings = (store.manual_holdings || []).filter((position) => remainingAccountIds.has(position.account_id));
  store.account_balance_snapshots = (store.account_balance_snapshots || []).filter((row) => remainingAccountIds.has(row.account_id));
  for (const key of Object.keys(store.position_overrides || {})) if (key.startsWith(`${item.id}:`)) delete store.position_overrides[key];
  store.transactions = store.transactions.filter((transaction) => transaction.item_id !== item.id);
  snapshotNetWorth(store);
  await saveStore(req.user, store, { allowEmptyConnectedStore: !store.items.some((candidate) => !candidate.demo) });
  res.json({ ok: true });
});

app.post('/api/items/:id/create_reconnect_token', plaidCostLimiter({ scope: 'plaid_reconnect_token', userLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 }), async (req, res) => {
  try {
    const store = await loadStore(req.user);
    const item = store.items.find((candidate) => candidate.id === req.params.id && !candidate.demo);
    if (!item?.access_token_enc) return res.status(404).json({ error: 'Connection not found.' });
    const body = { user: { client_user_id: req.user.storageKey }, client_name: 'Clarity', access_token: decrypt(item.access_token_enc), country_codes: ['US'], language: 'en' };
    if (process.env.PLAID_WEBHOOK_URL) body.webhook = process.env.PLAID_WEBHOOK_URL;
    const data = await plaidPost('/link/token/create', body);
    const reconnectSession = crypto.randomBytes(32).toString('base64url');
    reconnectSessions.set(reconnectSession, { userKey: req.user.storageKey, itemId: item.id, expiresAt: Date.now() + 30 * 60_000 });
    res.json({ link_token: data.link_token, reconnect_session: reconnectSession });
  } catch (error) {
    logOperationalError('Plaid reconnect token failed', error);
    res.status(error.status || 500).json(publicPlaidError(error));
  }
});

app.post('/api/items/:id/reconnected', plaidCostLimiter({ scope: 'plaid_reconnect_sync', userLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 }), async (req, res) => {
  const reconnectSession = String(req.body?.reconnect_session || '');
  const session = reconnectSessions.get(reconnectSession);
  reconnectSessions.delete(reconnectSession);
  if (!session || session.expiresAt < Date.now() || session.userKey !== req.user.storageKey || session.itemId !== req.params.id) return res.status(400).json({ error: 'This reconnect session expired. Please try again.' });
  try {
    const store = await loadStore(req.user);
    const item = store.items.find((candidate) => candidate.id === req.params.id && !candidate.demo);
    if (!item) return res.status(404).json({ error: 'Connection not found.' });
    await syncItem(store, item);
    hideDuplicateAccounts(store);
    snapshotNetWorth(store);
    snapshotInvestments(store);
    await saveStore(req.user, store);
    res.json({ ok: true });
    trackLaunchEvent(req.user, 'sync_succeeded');
  } catch (error) {
    logOperationalError('Reconnect sync failed', error);
    trackLaunchEvent(req.user, 'sync_failed');
    res.status(503).json({ error: 'Your institution was reconnected, but its latest data is still catching up. We will retry automatically.' });
  }
});

app.post('/api/plaid/create_link_token', plaidCostLimiter({ scope: 'plaid_link_token', userLimit: 5, ipLimit: 20, windowMs: 15 * 60_000 }), async (req, res) => {
  try {
    if (developmentMockConnectionsEnabled(req)) return res.json({ development_mock: true });
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
      transactions: { days_requested: 730 }
    };
    if (process.env.PLAID_WEBHOOK_URL) body.webhook = process.env.PLAID_WEBHOOK_URL;
    const data = await plaidPost('/link/token/create', body);
    res.json({ link_token: data.link_token });
    trackLaunchEvent(req.user, 'account_link_started');
  } catch (error) {
    logOperationalError('Plaid link token failed', error);
    res.status(error.status || 500).json(publicPlaidError(error));
  }
});

app.post('/api/plaid/development_mock_connect', async (req, res) => {
  if (!developmentMockConnectionsEnabled(req)) return res.status(404).json({ error: 'Not found.' });
  const store = await loadStore(req.user);
  if (store.settings?.demo_mode) return res.status(409).json({ error: 'Exit demo before connecting an account.' });
  const linkedItems = store.items.filter((item) => !item.demo).length;
  if (linkedItems >= MAX_LINKED_ITEMS) return res.status(429).json({ error: `You can connect up to ${MAX_LINKED_ITEMS} institutions. Unlink one before adding another.` });
  const { item, alreadyLinked } = addDevelopmentMockInstitution(store);
  await saveStore(req.user, store);
  trackLaunchEvent(req.user, 'account_link_completed');
  res.json({ ok: true, item: publicItem(item), development_mock: true, already_linked: alreadyLinked });
});

app.post('/api/plaid/exchange_public_token', plaidCostLimiter({ scope: 'plaid_item_exchange', userLimit: 10, ipLimit: 25, windowMs: 24 * 60 * 60_000 }), async (req, res) => {
  try {
    const { public_token, institution_name } = req.body;
    if (!public_token) return res.status(400).json({ error: 'public_token is required' });
    const store = await loadStore(req.user);
    const linkedItems = store.items.filter((item) => !item.demo).length;
    if (linkedItems >= MAX_LINKED_ITEMS) return res.status(429).json({ error: `You can connect up to ${MAX_LINKED_ITEMS} institutions. Unlink one before adding another.` });
    const exchanged = await plaidPost('/item/public_token/exchange', { public_token });
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
    // Persist the successful Plaid link before the first data sync. An
    // institution can take time to prepare transactions or holdings; a
    // temporary first-sync failure must not make an already-linked item vanish.
    await saveStore(req.user, store);
    try {
      await syncItem(store, item);
      hideDuplicateAccounts(store);
      snapshotNetWorth(store);
      snapshotInvestments(store);
      await saveStore(req.user, store);
      res.json({ ok: true, item: publicItem(item), sync_pending: false });
      trackLaunchEvent(req.user, 'sync_succeeded');
    } catch (error) {
      // The link itself succeeded. Preserve it with its actionable lifecycle
      // state so the profile can show retry/reconnect rather than data loss.
      await saveStore(req.user, store);
      res.status(202).json({ ok: true, item: publicItem(item), sync_pending: true });
      trackLaunchEvent(req.user, 'sync_failed');
    }
    trackLaunchEvent(req.user, 'account_link_completed');
  } catch (error) {
    logOperationalError('Plaid item exchange failed', error);
    res.status(error.status || 500).json(publicPlaidError(error, 'We could not finish connecting this institution. Please try again shortly.'));
  }
});

async function verifyPlaidWebhook(req) {
  const token = req.get('Plaid-Verification');
  if (!token || !req.rawBody?.length) return false;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== 'ES256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(header.kid)) return false;
    const cached = plaidWebhookKeyCache.get(header.kid);
    let key = cached?.expiresAt > Date.now() ? cached.key : null;
    if (!key) {
      const verification = await plaidPost('/webhook_verification_key/get', { key_id: header.kid });
      key = await importJWK(verification.key, 'ES256');
      plaidWebhookKeyCache.set(header.kid, { key, expiresAt: Date.now() + 60 * 60_000 });
    }
    const { payload } = await jwtVerify(token, key, { algorithms: ['ES256'], clockTolerance: '30s' });
    const expectedHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
    return typeof payload.request_body_sha256 === 'string'
      && payload.request_body_sha256.length === expectedHash.length
      && crypto.timingSafeEqual(Buffer.from(payload.request_body_sha256), Buffer.from(expectedHash));
  } catch (error) {
    logOperationalError('Rejected Plaid webhook', error);
    return false;
  }
}

app.post('/api/plaid/webhook', webhookLimiter, async (req, res) => {
  if (!await verifyPlaidWebhook(req)) return res.sendStatus(401);
  res.sendStatus(200);
  const itemId = req.body?.item_id;
  if (!itemId) return;
  try {
    let storageKeys = listUserStorageKeys();
    if (databaseEnabled()) storageKeys = [...new Set([...storageKeys, ...(await listDatabaseStoreKeys())])];
    for (const storageKey of storageKeys) {
      const found = await queueUserSync(storageKey, async () => {
        const store = await loadStoreByKey(storageKey);
        const item = store.items.find((candidate) => candidate.plaid_item_id === itemId);
        if (!item) return false;
        await syncItem(store, item);
        hideDuplicateAccounts(store);
        snapshotNetWorth(store);
        snapshotInvestments(store);
        await saveStoreByKey(storageKey, store);
        return true;
      });
      if (found) return;
    }
  } catch (error) { logOperationalError('Webhook sync failed', error); }
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
  store.investment_position_snapshots = [];
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

app.use((_req, res) => res.sendFile(path.join(projectRoot, 'public', 'index.html')));

// A dependency can still fail outside an individual route's try/catch (for
// example, while loading an encrypted store). Keep diagnostics in our logs and
// give customers one safe, recoverable API response rather than an Express
// stack trace, provider message, or a blank application shell.
app.use((error, req, res, next) => {
  logOperationalError('Unhandled application request failed', error, 'error');
  if (res.headersSent) return next(error);
  if (req.path.startsWith('/api/')) return res.status(503).json(publicErrorPayload('financial_data_unavailable'));
  res.status(503).type('html').send('<!doctype html><title>Clarity is temporarily unavailable</title><p>Clarity is temporarily unavailable. Please try again shortly.</p>');
});

export { app };

async function startServer() {
  if (databaseEnabled()) await migrateDatabase();
  app.listen(port, () => {
    console.log(`Clarity running at http://localhost:${port}`);
    console.log(`Plaid: ${plaidConfigured() ? `configured (${process.env.PLAID_ENV || 'sandbox'})` : 'not configured — demo mode available'}`);
  });
  scheduleDailySync();
  requestPendingInvestmentHistory().catch((error) => logOperationalError('Investment history request scheduler failed', error, 'error'));
  scheduleInvestmentHistoryRetries();
}

if (process.env.CLARITY_LISTEN !== 'false') {
  startServer().catch((error) => {
    logOperationalError('Database migration failed; refusing to start', error, 'error');
    process.exitCode = 1;
  });
}
