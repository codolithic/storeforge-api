import { type Table, getTableName } from 'drizzle-orm';
import type { SQLiteTable, IndexColumn } from 'drizzle-orm/sqlite-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const DATABASE_URL = process.env.DATABASE_URL ?? './data/dev.db';

export async function seedTable<T extends Table & SQLiteTable>(
  table: T,
  rows: T['$inferInsert'][],
  idColumn: IndexColumn,
) {
  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { table } });

  const tableName = getTableName(table);

  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(table)
        .values(row)
        .onConflictDoUpdate({
          target: idColumn,
          set: { ...row },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
    .all() as Array<{
    count: number;
  }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} ${tableName} into ${DATABASE_URL} (table now holds ${count}).`,
  );
}
