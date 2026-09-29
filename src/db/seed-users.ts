import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { users } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? './data/dev.db';

const SOURCE = new URL('../../data/users.json', import.meta.url);

const userSeedSchema = z.object({
  id: z.number().int().positive(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.email(),
  passwordHash: z.string(),
  role: z.enum(['customer', 'admin']),
});

const userSeedFileSchema = z.array(userSeedSchema).min(1);

export async function seedUsers(): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(SOURCE, 'utf8'));
  const rows = userSeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { users } });

  const existingUsersCount = await db.$count(users);
  if (existingUsersCount > 0) {
    throw new Error('users table is not empty');
  }

  db.transaction((tx) => {
    for (const { id, firstName, lastName, email, passwordHash, role } of rows) {
      tx.insert(users)
        .values({ id, email, firstName, lastName, passwordHash, role })
        .onConflictDoUpdate({
          target: users.id,
          set: { firstName, lastName, email, passwordHash, role },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM users')
    .all() as Array<{
    count: number;
  }>;

  sqlite.close();
  console.log(`✅ Seeded ${rows.length} users into ${DATABASE_URL} (table now holds ${count}).`);
}
