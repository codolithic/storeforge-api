import { readFile } from 'node:fs/promises';
import { json } from 'drizzle-orm/pg-core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { productVariants } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? './data/dev.db';

const SOURCE = new URL('../../data/product_variants.json', import.meta.url);

const productVariantSeedSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  sku: z.string(),
  price: z.float32(),
  attributes: z.json().nullable(),
  stockQuantity: z.number().int().min(0),
});

const productVariantSeedFileSchema = z.array(productVariantSeedSchema).min(1);

export async function seedProductVariants(): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(SOURCE, 'utf8'));
  const rows = productVariantSeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { productVariants } });

  const existingVariantsCount = await db.$count(productVariants);
  if (existingVariantsCount > 0) {
    throw new Error('product_variants table is not empty');
  }

  db.transaction((tx) => {
    for (const { id, productId, sku, price, attributes, stockQuantity } of rows) {
      tx.insert(productVariants)
        .values({
          id,
          productId,
          sku,
          price,
          attributes: JSON.parse(JSON.stringify(attributes)),
          stockQuantity,
        })
        .onConflictDoUpdate({
          target: productVariants.id,
          set: {
            productId,
            sku,
            price,
            attributes: JSON.parse(JSON.stringify(attributes)),
            stockQuantity,
          },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM product_variants')
    .all() as Array<{
    count: number;
  }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} product variants into ${DATABASE_URL} (table now holds ${count}).`,
  );
}
