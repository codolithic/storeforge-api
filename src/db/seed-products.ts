import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { products } from "./schema.js";

// Reads DATABASE_URL directly rather than importing config/env.ts, for the same
// reason as seed.ts: a DB-only CLI script shouldn't require JWT secrets.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "./data/dev.db";

// Resolved against this module, not cwd, so the script works from any directory.
const SOURCE = new URL(
  "../../data/products.json",
  import.meta.url,
);

const productSeedSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable().optional(),
  basePrice: z.number().positive(),
  categoryId: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional(),
  status: z.enum(["active", "draft", "archived"]),
});

const productSeedFileSchema = z
  .array(productSeedSchema)
  .min(1);

export async function seedProducts(): Promise<void> {
  const raw: unknown = JSON.parse(
    await readFile(SOURCE, "utf8"),
  );
  const rows = productSeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: { products } });

  // products.category_id is a real FK, so categories must be seeded first.
  // Checking up front turns an opaque "FOREIGN KEY constraint failed" into
  // an actionable message.
  const existingCategoryIds = new Set(
    (
      sqlite
        .prepare("SELECT id FROM categories")
        .all() as Array<{ id: number }>
    ).map((c) => c.id),
  );
  const missing = [
    ...new Set(
      rows
        .map((row) => row.categoryId)
        .filter(
          (id): id is number =>
            id != null && !existingCategoryIds.has(id),
        ),
    ),
  ].sort((a, b) => a - b);

  if (missing.length > 0) {
    sqlite.close();
    throw new Error(
      `Cannot seed products: ${missing.length} referenced category id(s) do not exist ` +
        `(${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ", …" : ""}). ` +
        `Run \`npm run db:seed\` first to populate categories.`,
    );
  }

  // Explicit ids are preserved so order_items/cart_items seeded later line up.
  // Re-running updates in place rather than deleting, which keeps any rows
  // referencing a product (variants, images) intact.
  db.transaction((tx) => {
    for (const row of rows) {
      tx.insert(products)
        .values({
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description ?? null,
          basePrice: row.basePrice,
          categoryId: row.categoryId ?? null,
          status: row.status,
        })
        .onConflictDoUpdate({
          target: products.id,
          set: {
            name: row.name,
            slug: row.slug,
            description: row.description ?? null,
            basePrice: row.basePrice,
            categoryId: row.categoryId ?? null,
            status: row.status,
            updatedAt: sql`(current_timestamp)`,
          },
        })
        .run();
    }
  });

  const [totals = { count: 0 }] = sqlite
    .prepare("SELECT COUNT(*) AS count FROM products")
    .all() as Array<{ count: number }>;
  const byStatus = sqlite
    .prepare(
      "SELECT status, COUNT(*) AS count FROM products GROUP BY status ORDER BY status",
    )
    .all() as Array<{ status: string; count: number }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} products into ${DATABASE_URL} (table now holds ${totals.count}).`,
  );
  console.log(
    `   ${byStatus.map((s) => `${s.status}: ${s.count}`).join(", ")}`,
  );
}
