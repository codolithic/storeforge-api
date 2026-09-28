import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import { categories } from "./schema.js";

// Deliberately reads DATABASE_URL directly instead of importing config/env.ts
// (same approach as drizzle.config.ts): this is a DB-only CLI script and should
// not require JWT_ACCESS_SECRET/JWT_REFRESH_SECRET just to open the file.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "./data/dev.db";

// Resolved against this module, not cwd, so the script works from any directory.
const SOURCE = new URL(
  "../../data/categories.json",
  import.meta.url,
);

// `parentId` is accepted but ignored — the categories table has no parent_id
// column (categories are a flat list). Kept in the schema so the source file
// doesn't have to be edited, and so we can warn about what's being discarded.
const categorySeedSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
});

const categorySeedFileSchema = z
  .array(categorySeedSchema)
  .min(1);

export async function seedCategories(): Promise<void> {
  const raw: unknown = JSON.parse(
    await readFile(SOURCE, "utf8"),
  );
  const rows = categorySeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: { categories } });

  // Explicit ids are preserved so that anything referencing categories by id
  // (e.g. products.categoryId in other seed data) stays consistent.
  // Re-running is safe: an existing id is updated in place rather than dropped,
  // which keeps products.category_id foreign keys intact.
  db.transaction((tx) => {
    for (const { id, name, slug } of rows) {
      tx.insert(categories)
        .values({ id, name, slug })
        .onConflictDoUpdate({
          target: categories.id,
          set: { name, slug },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare("SELECT COUNT(*) AS count FROM categories")
    .all() as Array<{ count: number }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} categories into ${DATABASE_URL} (table now holds ${count}).`,
  );
}
