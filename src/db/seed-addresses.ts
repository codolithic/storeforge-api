import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { addresses } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? './data/dev.db';

const SOURCE = new URL('../../data/addresses.json', import.meta.url);

const addressSeedSchema = z.object({
  id: z.number().int().positive(),
  userId: z.number().int().positive(),
  line1: z.string().nonempty(),
  line2: z.string().nullable(),
  city: z.string().nonempty(),
  state: z.string().nonempty(),
  postalCode: z.string().nonempty(),
  country: z.string().nonempty().default('Australia'),
  isDefault: z.boolean().nonoptional(),
});

const addressSeedFileSchema = z.array(addressSeedSchema).min(1);

export async function seedAddresses(): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(SOURCE, 'utf8'));
  const rows = addressSeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { addresses } });

  const existingAddressesCount = await db.$count(addresses);
  if (existingAddressesCount > 0) {
    throw new Error('addresses table is not empty');
  }

  db.transaction((tx) => {
    for (const { id, userId, line1, line2, city, state, postalCode, country, isDefault } of rows) {
      tx.insert(addresses)
        .values({ id, line1, line2, city, state, postalCode, country, isDefault, userId })
        .onConflictDoUpdate({
          target: addresses.id,
          set: { line1, line2, city, state, postalCode, country, isDefault },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM addresses')
    .all() as Array<{
    count: number;
  }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} addresses into ${DATABASE_URL} (table now holds ${count}).`,
  );
}
