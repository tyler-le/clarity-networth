import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

function demoMode() {
  return String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';
}

function storePath(userKey) {
  if (!userKey) return path.join(DATA_DIR, demoMode() ? 'store.demo.json' : 'store.json');
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  return path.join(DATA_DIR, 'users', `${userKey}.json`);
}

const emptyStore = () => ({
  items: [],
  accounts: [],
  positions: [],
  investment_snapshots: [],
  transactions: [],
  snapshots: [],
  settings: {
    targets: { fixed: 50, savings: 10, investments: 10, guilt_free: 30 },
    fire: {
      age: 27,
      retirement_age: 65,
      withdrawal_rate: 4,
      real_return: 5,
      lean_multiplier: 70,
      fat_multiplier: 150
    },
    demo_mode: false
  }
});

export function readStore(userKey) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const currentStorePath = storePath(userKey);
  if (!fs.existsSync(currentStorePath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(currentStorePath, 'utf8'));
    const defaults = emptyStore();
    return {
      ...defaults,
      ...parsed,
      settings: {
        ...defaults.settings,
        ...(parsed.settings || {}),
        targets: { ...defaults.settings.targets, ...(parsed.settings?.targets || {}) },
        fire: { ...defaults.settings.fire, ...(parsed.settings?.fire || {}) }
      }
    };
  } catch {
    return emptyStore();
  }
}

export function writeStore(store, userKey) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const currentStorePath = storePath(userKey);
  fs.mkdirSync(path.dirname(currentStorePath), { recursive: true });
  const tmp = `${currentStorePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, currentStorePath);
}

export function removeDemoData(store) {
  const containsDemo = [store.items, store.accounts, store.positions || [], store.transactions].some((records) => records.some((record) => record.demo));
  if (!containsDemo) return false;
  store.items = store.items.filter((item) => !item.demo);
  store.accounts = store.accounts.filter((account) => !account.demo);
  store.positions = (store.positions || []).filter((position) => !position.demo);
  store.investment_snapshots = [];
  store.transactions = store.transactions.filter((transaction) => !transaction.demo);
  // Existing snapshots do not carry a mode marker, so a mixed store cannot
  // distinguish real history from the demo baseline.
  store.snapshots = [];
  return true;
}

function encryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || 'development-only-key-change-me';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function resetStore(userKey) {
  writeStore(emptyStore(), userKey);
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
