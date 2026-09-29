import { readFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { productImages } from './schema.js';

const DATABASE_URL = process.env.DATABASE_URL ?? './data/dev.db';

const SOURCE = new URL('../../data/product_images.json', import.meta.url);

const productImageSeedSchema = z.object({
  id: z.number().int().positive(),
  productId: z.number().int().positive(),
  url: z.url(),
  // position: z.number().int().positive().optional().default(0),
});

const productImageSeedFileSchema = z.array(productImageSeedSchema).min(1);

export async function seedProductImages(): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(SOURCE, 'utf8'));
  const rows = productImageSeedFileSchema.parse(raw);

  const sqlite = new Database(DATABASE_URL);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: { productImages } });

  const existingImagesCount = await db.$count(productImages);
  if (existingImagesCount > 0) {
    throw new Error('product_images table is not empty');
  }

  db.transaction((tx) => {
    for (const { id, productId, url } of rows) {
      tx.insert(productImages)
        .values({ id, productId, url })
        .onConflictDoUpdate({
          target: productImages.id,
          set: { productId, url },
        })
        .run();
    }
  });

  const [{ count } = { count: 0 }] = sqlite
    .prepare('SELECT COUNT(*) AS count FROM product_images')
    .all() as Array<{
    count: number;
  }>;

  sqlite.close();
  console.log(
    `✅ Seeded ${rows.length} product images into ${DATABASE_URL} (table now holds ${count}).`,
  );
}
