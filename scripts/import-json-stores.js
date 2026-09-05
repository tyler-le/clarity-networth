import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDatabase, importLegacyStore, migrateDatabase } from '../database.js';

const dryRun = process.argv.includes('--dry-run');
const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR must point to the legacy JSON volume.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const usersDir = path.join(dataDir, 'users');
const filenames = (await fs.readdir(usersDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)).map((entry) => entry.name).sort();
await migrateDatabase();

let imported = 0;
for (const filename of filenames) {
  const userKey = filename.slice(0, -'.json'.length);
  const filePath = path.join(usersDir, filename);
  const [raw, stat] = await Promise.all([fs.readFile(filePath, 'utf8'), fs.stat(filePath)]);
  const payload = JSON.parse(raw);
  if (!dryRun) await importLegacyStore(userKey, payload, stat.mtime);
  imported += 1;
}
await closeDatabase();
console.log(`${dryRun ? 'Validated' : 'Imported'} ${imported} user store${imported === 1 ? '' : 's'}; legacy JSON was not modified.`);
