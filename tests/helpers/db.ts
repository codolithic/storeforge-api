import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from '../../src/db/index.js';
import { env } from '../../src/config/env.js';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

// Builds the schema from the committed migrations. Refuses to run against a
// file DB so a misconfigured test run can never touch data/dev.db.
export function migrateTestDb() {
  if (env.DATABASE_URL !== ':memory:') {
    throw new Error(`Tests must use an in-memory DB, got DATABASE_URL=${env.DATABASE_URL}`);
  }
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
