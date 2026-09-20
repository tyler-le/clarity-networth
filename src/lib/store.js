import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decryptPayload, encryptPayload, isEncryptedPayload } from './secure-payload.js';
import { normalizeMembership } from './entitlements.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const BACKUP_RETENTION_DAYS = 35;

function demoMode() {
  return String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
}

function storePath(userKey) {
  if (!userKey) return path.join(DATA_DIR, demoMode() ? 'store.demo.json' : 'store.json');
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  return path.join(DATA_DIR, 'users', `${userKey}.json`);
}

function backupDirectory(userKey) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  return path.join(DATA_DIR, 'backups', userKey);
}

function snapshotStoreBackup(userKey, sourcePath) {
  // The active volume is a recovery mirror for Postgres. Daily immutable
  // encrypted snapshots add protection from bad writes and deployments while
  // keeping a bounded retention window for data-deletion compliance.
  if (!userKey) return;
  const directory = backupDirectory(userKey);
  fs.mkdirSync(directory, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const destination = path.join(directory, `${today}.json`);
  if (!fs.existsSync(destination)) fs.copyFileSync(sourcePath, destination);
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(directory)) {
    const candidate = path.join(directory, name);
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name) || fs.statSync(candidate).mtimeMs >= cutoff) continue;
    fs.rmSync(candidate, { force: true });
  }
}

const emptyStore = () => ({
  items: [],
  accounts: [],
  positions: [],
  manual_holdings: [],
  position_overrides: {},
  investment_transactions: [],
  investment_link_events: [],
  market_prices: {},
  investment_snapshots: [],
  investment_position_snapshots: [],
  // Daily provider-observed balances for connected non-investment accounts.
  // Keep this separate from aggregate net-worth and investment ledgers so a
  // detail view never has to reconstruct an account's past from transactions.
  account_balance_snapshots: [],
  transactions: [],
  snapshots: [],
  settings: {
    targets: { fixed: 50, savings: 10, investments: 10, guilt_free: 30 },
    fire: {
      age: 27,
      retirement_age: 65,
      withdrawal_rate: 4,
      real_return: 5,
      trailing_months: 12,
      lean_multiplier: 70,
      fat_multiplier: 150
    },
    demo_mode: false,
    membership: normalizeMembership(),
    goals: [],
    appearance: { theme: 'light' }
  }
});

export function normalizeStore(parsed) {
  const defaults = emptyStore();
  return {
    ...defaults,
    ...parsed,
    // Plaid calls the current investment family `investment`; `brokerage` is
    // a legacy API value. Normalize once at the storage boundary so every
    // downstream surface handles it as an investment rather than silently
    // dropping it into an unsupported "Other" bucket.
    accounts: Array.isArray(parsed.accounts)
      ? parsed.accounts.map((account) => account?.type === 'brokerage' ? { ...account, type: 'investment' } : account)
      : defaults.accounts,
    settings: {
      ...defaults.settings,
      ...(parsed.settings || {}),
      targets: { ...defaults.settings.targets, ...(parsed.settings?.targets || {}) },
      fire: { ...defaults.settings.fire, ...(parsed.settings?.fire || {}) },
      membership: normalizeMembership(parsed.settings?.membership),
      goals: Array.isArray(parsed.settings?.goals) ? parsed.settings.goals : [],
      appearance: { ...defaults.settings.appearance, ...(parsed.settings?.appearance || {}) }
    }
  };
}

export function readStore(userKey) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const currentStorePath = storePath(userKey);
  if (!fs.existsSync(currentStorePath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(currentStorePath, 'utf8'));
    const store = isEncryptedPayload(parsed?.payload_enc) ? JSON.parse(decryptPayload(parsed.payload_enc)) : parsed;
    return normalizeStore(store);
  } catch {
    return emptyStore();
  }
}

export function writeStore(store, userKey) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const currentStorePath = storePath(userKey);
  fs.mkdirSync(path.dirname(currentStorePath), { recursive: true });
  // Preserve the last known-good encrypted payload before replacing it. A
  // recovery snapshot taken after rename can only preserve the bad write.
  if (fs.existsSync(currentStorePath)) snapshotStoreBackup(userKey, currentStorePath);
  const tmp = `${currentStorePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, payload_enc: encryptPayload(JSON.stringify(store)) }));
  fs.renameSync(tmp, currentStorePath);
}

export function removeDemoData(store) {
  const containsDemo = [store.items, store.accounts, store.positions || [], store.transactions].some((records) => records.some((record) => record.demo));
  if (!containsDemo) return false;
  store.items = store.items.filter((item) => !item.demo);
  store.accounts = store.accounts.filter((account) => !account.demo);
  store.positions = (store.positions || []).filter((position) => !position.demo);
  store.manual_holdings = (store.manual_holdings || []).filter((position) => !position.demo);
  store.investment_transactions = [];
  store.market_prices = {};
  store.investment_snapshots = [];
  store.investment_position_snapshots = [];
  store.transactions = store.transactions.filter((transaction) => !transaction.demo);
  // Existing snapshots do not carry a mode marker, so a mixed store cannot
  // distinguish real history from the demo baseline.
  store.snapshots = [];
  return true;
}

export function encrypt(text) {
  return encryptPayload(text).slice(3);
}

export function decrypt(payload) {
  return decryptPayload(`v1.${payload}`);
}

export function resetStore(userKey) {
  writeStore(emptyStore(), userKey);
}

export function deleteStore(userKey) {
  const currentStorePath = storePath(userKey);
  if (fs.existsSync(currentStorePath)) fs.rmSync(currentStorePath);
  if (userKey) {
    const backups = backupDirectory(userKey);
    if (fs.existsSync(backups)) fs.rmSync(backups, { recursive: true, force: true });
  }
}

export function userStorageKey(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

export function hasLegacyStore() {
  return fs.existsSync(storePath());
}

export function listUserStorageKeys() {
  const usersDir = path.join(DATA_DIR, 'users');
  if (!fs.existsSync(usersDir)) return [];
  return fs.readdirSync(usersDir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => name.slice(0, -5));
}
