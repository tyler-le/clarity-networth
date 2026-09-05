import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { decryptPayload, encryptPayload, isEncryptedPayload } from './secure-payload.js';

const { Pool } = pg;
let pool;

export function databaseEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!databaseEnabled()) throw new Error('DATABASE_URL is not configured.');
  pool ||= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 20_000 });
  return pool;
}

export async function migrateDatabase() {
  if (!databaseEnabled()) return false;
  const client = await getPool().connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = path.join(path.dirname(new URL(import.meta.url).pathname), 'db', 'migrations');
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    // Version 1 stored a JSONB compatibility payload. Convert it in place after
    // the encrypted column exists, leaving only an empty compatibility object.
    const legacyRows = await client.query("SELECT user_key, payload FROM financial_stores WHERE payload_enc IS NULL AND payload <> '{}'::jsonb");
    for (const row of legacyRows.rows) {
      const serialized = JSON.stringify(row.payload);
      await client.query("UPDATE financial_stores SET payload = '{}'::jsonb, payload_enc = $2 WHERE user_key = $1", [row.user_key, encryptPayload(serialized)]);
    }
    return true;
  } finally {
    client.release();
  }
}

export async function importLegacyStore(userKey, payload, sourceUpdatedAt = new Date()) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  const serialized = JSON.stringify(payload);
  const sourceHash = crypto.createHash('sha256').update(serialized).digest('hex');
  await getPool().query(
    `INSERT INTO financial_stores (user_key, payload, payload_enc, source_hash, source_updated_at, imported_at)
     VALUES ($1, '{}'::jsonb, $2, $3, $4, now())
     ON CONFLICT (user_key) DO UPDATE SET
       payload = '{}'::jsonb,
       payload_enc = EXCLUDED.payload_enc,
       source_hash = EXCLUDED.source_hash,
       source_updated_at = EXCLUDED.source_updated_at,
       imported_at = now()
     WHERE financial_stores.source_hash IS DISTINCT FROM EXCLUDED.source_hash`,
    [userKey, encryptPayload(serialized), sourceHash, sourceUpdatedAt]
  );
  return sourceHash;
}

export async function readDatabaseStore(userKey) {
  if (!/^[a-f0-9]{64}$/.test(userKey)) throw new Error('Invalid user storage key.');
  const result = await getPool().query('SELECT payload_enc FROM financial_stores WHERE user_key = $1', [userKey]);
  if (!result.rowCount) return null;
  const encrypted = result.rows[0].payload_enc;
  if (!isEncryptedPayload(encrypted)) throw new Error('Encrypted database payload is unavailable.');
  return JSON.parse(decryptPayload(encrypted));
}

export async function writeDatabaseStore(userKey, payload) {
  return importLegacyStore(userKey, payload, new Date());
}

export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}
