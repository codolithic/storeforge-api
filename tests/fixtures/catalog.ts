import { db } from '../../src/db/index.js';
import { categories, productImages, products, productVariants } from '../../src/db/schema.js';

// Small hand-built catalog; every filter/sort/pagination case in the products
// tests is asserted against these exact rows, so change them with care.
//
//   Electronics (1)            Kitchen (4)
//   ├─ Audio (2)
//   └─ Phones (3)
//
// 8 active products; 9 is draft and 10 is archived (never publicly visible).
export const CATEGORY_ROWS = [
  { id: 1, name: 'Electronics', slug: 'electronics', parentId: null },
  { id: 2, name: 'Audio', slug: 'audio', parentId: 1 },
  { id: 3, name: 'Phones', slug: 'phones', parentId: 1 },
  { id: 4, name: 'Kitchen', slug: 'kitchen', parentId: null },
];

export const PRODUCT_ROWS = [
  { id: 1, name: 'Alpha Headphones', slug: 'alpha-headphones', basePrice: 100, categoryId: 2 },
  { id: 2, name: 'Beta Speaker', slug: 'beta-speaker', basePrice: 50, categoryId: 2 },
  { id: 3, name: 'Gamma Phone', slug: 'gamma-phone', basePrice: 500, categoryId: 3 },
  { id: 4, name: 'Delta Phone', slug: 'delta-phone', basePrice: 500, categoryId: 3 },
  { id: 5, name: 'Electronics Hub', slug: 'electronics-hub', basePrice: 200, categoryId: 1 },
  { id: 6, name: 'Kettle 100% Steel', slug: 'kettle-steel', basePrice: 30, categoryId: 4 },
  { id: 7, name: 'Toaster_Pro', slug: 'toaster-pro', basePrice: 80, categoryId: 4 },
  { id: 8, name: 'ToasterXPro', slug: 'toaster-x-pro', basePrice: 90, categoryId: 4 },
].map((p) => ({ ...p, description: `${p.name} description`, status: 'active' as const }));

export const HIDDEN_PRODUCT_ROWS = [
  {
    id: 9,
    name: 'Draft Headphones',
    slug: 'draft-headphones',
    basePrice: 120,
    categoryId: 2,
    status: 'draft' as const,
  },
  {
    id: 10,
    name: 'Archived Phone',
    slug: 'archived-phone',
    basePrice: 400,
    categoryId: 3,
    status: 'archived' as const,
  },
];

// Inserted out of position order on purpose; expected order for product 1 is 2, 3, 1.
export const IMAGE_ROWS = [
  { id: 1, productId: 1, url: 'https://img.test/alpha-c.png', position: 2 },
  { id: 2, productId: 1, url: 'https://img.test/alpha-a.png', position: 0 },
  { id: 3, productId: 1, url: 'https://img.test/alpha-b.png', position: 1 },
  { id: 4, productId: 3, url: 'https://img.test/gamma.png', position: 0 },
  { id: 5, productId: 9, url: 'https://img.test/draft.png', position: 0 },
];

// Product 1: price tie between 2 and 3 (tie-broken by id), variant 1 out of stock.
export const VARIANT_ROWS = [
  {
    id: 1,
    productId: 1,
    sku: 'ALPHA-RED',
    price: 120,
    attributes: { color: 'Red' },
    stockQuantity: 0,
  },
  {
    id: 2,
    productId: 1,
    sku: 'ALPHA-BLK',
    price: 100,
    attributes: { color: 'Black' },
    stockQuantity: 5,
  },
  {
    id: 3,
    productId: 1,
    sku: 'ALPHA-WHT',
    price: 100,
    attributes: { color: 'White' },
    stockQuantity: 2,
  },
  { id: 4, productId: 3, sku: 'GAMMA-128', price: 500, attributes: null, stockQuantity: 1 },
];

export async function seedCatalog() {
  await db.insert(categories).values(CATEGORY_ROWS);
  await db.insert(products).values([...PRODUCT_ROWS, ...HIDDEN_PRODUCT_ROWS]);
  await db.insert(productImages).values(IMAGE_ROWS);
  await db.insert(productVariants).values(VARIANT_ROWS);
}
