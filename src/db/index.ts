import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { env } from '../config/env.js';

const sqlite = new Database(env.DATABASE_URL);

// WAL mode reduces write-lock contention (SQLite's single-writer limitation
// is the main reason you'd migrate to Postgres for real production scale).
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema, logger: env.NODE_ENV !== 'test' });

export const {
  users,
  addresses,
  categories,
  products,
  productImages,
  productVariants,
  carts,
  cartItems,
  orders,
  orderItems,
  payments,
  inventoryReservations,
  reviews,
} = schema;
export type Category = typeof schema.categories.$inferSelect;
export type Product = typeof schema.products.$inferSelect;
export type NewProduct = typeof schema.products.$inferInsert;
