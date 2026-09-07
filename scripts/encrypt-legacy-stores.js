import fs from 'node:fs/promises';
import path from 'node:path';
import { readStore, writeStore } from '../src/lib/store.js';

const dataDir = process.env.DATA_DIR;
if (!dataDir) throw new Error('DATA_DIR must point to the legacy JSON volume.');

const usersDir = path.join(dataDir, 'users');
const filenames = (await fs.readdir(usersDir, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
  .map((entry) => entry.name)
  .sort();

for (const filename of filenames) {
  const userKey = filename.slice(0, -'.json'.length);
  // readStore supports both old plaintext JSON and the authenticated encrypted
  // envelope; writeStore always writes the encrypted envelope atomically.
  writeStore(readStore(userKey), userKey);
}

console.log(`Encrypted ${filenames.length} legacy user store${filenames.length === 1 ? '' : 's'} in place.`);
