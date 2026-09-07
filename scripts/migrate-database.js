import { closeDatabase, migrateDatabase } from '../src/lib/database.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
await migrateDatabase();
await closeDatabase();
console.log('Database migrations complete.');
