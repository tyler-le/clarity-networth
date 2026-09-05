import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR must point to the legacy JSON volume.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const usersDir = path.join(dataDir, 'users');
const filenames = (await fs.readdir(usersDir, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  let verified = 0;
  for (const filename of filenames) {
    const userKey = filename.slice(0, -'.json'.length);
    const raw = await fs.readFile(path.join(usersDir, filename), 'utf8');
    const sourceHash = crypto.createHash('sha256').update(JSON.stringify(JSON.parse(raw))).digest('hex');
    const result = await pool.query('SELECT source_hash FROM financial_stores WHERE user_key = $1', [userKey]);
    if (result.rowCount !== 1 || result.rows[0].source_hash !== sourceHash) {
      throw new Error(`Database verification failed for a legacy store.`);
    }
    verified += 1;
  }
  console.log(`Verified ${verified} database store${verified === 1 ? '' : 's'} against legacy JSON hashes.`);
} finally {
  await pool.end();
}
