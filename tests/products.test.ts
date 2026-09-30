import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { migrateTestDb } from './helpers/db.js';
import { PRODUCT_ROWS, seedCatalog } from './fixtures/catalog.js';

// Every expected id list below is derived from the rows in fixtures/catalog.ts.

type Query = Record<string, string | number>;

const listProducts = (query: Query = {}) => request(app).get('/api/products').query(query);

async function listIds(query: Query = {}) {
  const res = await listProducts(query);
  expect(res.status).toBe(200);
  return res.body.data.items.map((p: { id: number }) => p.id) as number[];
}

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
});

describe('GET /api/products', () => {
  describe('response', () => {
    it('returns the success envelope with default pagination, without auth', async () => {
      const res = await listProducts();

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pagination).toEqual({ page: 1, limit: 20, total: 8, totalPages: 1 });
    });

    it('returns the listing fields with the category name and images ordered by position', async () => {
      const res = await listProducts({ search: 'Alpha' });

      expect(res.body.data.items).toEqual([
        {
          id: 1,
          name: 'Alpha Headphones',
          slug: 'alpha-headphones',
          description: 'Alpha Headphones description',
          basePrice: 100,
          category: 'Audio',
          status: 'active',
          images: [
            { id: 2, url: 'https://img.test/alpha-a.png' },
            { id: 3, url: 'https://img.test/alpha-b.png' },
            { id: 1, url: 'https://img.test/alpha-c.png' },
          ],
        },
      ]);
    });

    it('returns an empty images array for a product without images', async () => {
      const res = await listProducts({ search: 'Beta' });
      expect(res.body.data.items[0].images).toEqual([]);
    });

    it('only attaches each product its own images', async () => {
      const res = await listProducts({ limit: 100 });
      const imageIds = res.body.data.items.flatMap((p: { images: { id: number }[] }) =>
        p.images.map((i) => i.id),
      );

      // Image 5 belongs to the draft product and must not leak into the listing.
      expect(imageIds.sort()).toEqual([1, 2, 3, 4]);
    });
  });

  describe('visibility', () => {
    it('lists only active products, and counts only active products in total', async () => {
      const res = await listProducts({ limit: 100 });
      const ids = res.body.data.items
        .map((p: { id: number }) => p.id)
        .sort((a: number, b: number) => a - b);

      expect(ids).toEqual(PRODUCT_ROWS.map((p) => p.id));
      expect(res.body.data.pagination.total).toBe(PRODUCT_ROWS.length);
    });
  });

  describe('category filter', () => {
    it('includes products from subcategories when filtering by a parent category', async () => {
      expect(await listIds({ category: 'electronics' })).toEqual([1, 2, 4, 5, 3]);
    });

    it('returns only that category when filtering by a child category', async () => {
      expect(await listIds({ category: 'audio' })).toEqual([1, 2]);
    });

    it('returns an empty page for an unknown category', async () => {
      const res = await listProducts({ category: 'does-not-exist' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });
  });

  describe('search', () => {
    it('matches anywhere in the name, case-insensitively', async () => {
      expect(await listIds({ search: 'HEADPHONES' })).toEqual([1]);
      expect(await listIds({ search: 'phone' })).toEqual([1, 4, 3]);
    });

    it('treats % as a literal character, not a wildcard', async () => {
      expect(await listIds({ search: '%' })).toEqual([6]);
      expect(await listIds({ search: '100%' })).toEqual([6]);
    });

    it('treats _ as a literal character, not a single-char wildcard', async () => {
      expect(await listIds({ search: 'Toaster_Pro' })).toEqual([7]);
      expect(await listIds({ search: '_' })).toEqual([7]);
    });

    it('trims surrounding whitespace', async () => {
      expect(await listIds({ search: '  Kettle  ' })).toEqual([6]);
    });
  });

  describe('price range', () => {
    it('includes products priced exactly on both bounds', async () => {
      expect(await listIds({ min_price: 80, max_price: 200, sort: 'price' })).toEqual([7, 8, 1, 5]);
    });

    it('supports a lower bound on its own', async () => {
      expect(await listIds({ min_price: 500 })).toEqual([4, 3]);
    });

    it('supports an upper bound on its own', async () => {
      expect(await listIds({ max_price: 50, sort: 'price' })).toEqual([6, 2]);
    });

    it('accepts min_price equal to max_price', async () => {
      expect(await listIds({ min_price: 500, max_price: 500 })).toEqual([4, 3]);
    });

    it('combines with category and search filters', async () => {
      expect(await listIds({ category: 'electronics', search: 'phone', min_price: 100 })).toEqual([
        1, 4, 3,
      ]);
    });
  });

  describe('sorting', () => {
    it('sorts by name ascending by default', async () => {
      // SQLite's default BINARY collation: 'X' (0x58) sorts before '_' (0x5F).
      expect(await listIds()).toEqual([1, 2, 4, 5, 3, 6, 8, 7]);
    });

    it('sorts by name descending', async () => {
      expect(await listIds({ order: 'desc' })).toEqual([7, 8, 6, 3, 5, 4, 2, 1]);
    });

    it('sorts by price, tie-breaking equal prices by id in both directions', async () => {
      expect(await listIds({ sort: 'price' })).toEqual([6, 2, 7, 8, 1, 5, 3, 4]);
      expect(await listIds({ sort: 'price', order: 'desc' })).toEqual([3, 4, 5, 1, 8, 7, 2, 6]);
    });

    it('sorts by category name, tie-breaking by id', async () => {
      expect(await listIds({ sort: 'category' })).toEqual([1, 2, 5, 6, 7, 8, 3, 4]);
      expect(await listIds({ sort: 'category', order: 'desc' })).toEqual([3, 4, 6, 7, 8, 5, 1, 2]);
    });
  });

  describe('pagination', () => {
    it('returns the requested slice with pagination metadata', async () => {
      const res = await listProducts({ page: 2, limit: 3 });

      expect(res.body.data.items.map((p: { id: number }) => p.id)).toEqual([5, 3, 6]);
      expect(res.body.data.pagination).toEqual({ page: 2, limit: 3, total: 8, totalPages: 3 });
    });

    it('returns a partial last page', async () => {
      expect(await listIds({ page: 3, limit: 3 })).toEqual([8, 7]);
    });

    it('computes totalPages when total is an exact multiple of limit', async () => {
      const res = await listProducts({ limit: 4 });
      expect(res.body.data.pagination.totalPages).toBe(2);
    });

    it('returns an empty page past the end but still reports the real total', async () => {
      const res = await listProducts({ page: 99, limit: 3 });
      expect(res.body.data).toEqual({
        items: [],
        pagination: { page: 99, limit: 3, total: 8, totalPages: 3 },
      });
    });

    it('never repeats or skips a product across pages, even with tied sort values', async () => {
      const pages = await Promise.all(
        [1, 2, 3].map((page) => listIds({ page, limit: 3, sort: 'price' })),
      );
      expect(pages.flat()).toEqual(await listIds({ limit: 100, sort: 'price' }));
    });

    it('applies filters before paginating', async () => {
      const res = await listProducts({ category: 'kitchen', page: 2, limit: 2 });

      expect(res.body.data.items.map((p: { id: number }) => p.id)).toEqual([7]);
      expect(res.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    });

    it.each([1, 100])('accepts limit=%i', async (limit) => {
      expect((await listProducts({ limit })).status).toBe(200);
    });
  });

  describe('validation', () => {
    it.each([
      ['page', '0'],
      ['page', '-1'],
      ['page', '1.5'],
      ['page', 'abc'],
      ['limit', '0'],
      ['limit', '101'],
      ['limit', '2.5'],
      ['min_price', '-1'],
      ['max_price', 'cheap'],
      ['sort', 'popularity'],
      ['order', 'up'],
      ['category', '   '],
      ['search', ''],
      ['search', 'x'.repeat(101)],
    ])('returns 400 VALIDATION_ERROR for %s=%j', async (field, value) => {
      const res = await listProducts({ [field]: value });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid request data' },
      });
      expect(res.body.error.details.fieldErrors).toHaveProperty(field);
    });

    it('reports every invalid field at once', async () => {
      const res = await listProducts({ page: '0', sort: 'popularity' });
      expect(Object.keys(res.body.error.details.fieldErrors).sort()).toEqual(['page', 'sort']);
    });

    it('rejects min_price greater than max_price', async () => {
      const res = await listProducts({ min_price: 50, max_price: 10 });

      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors.min_price).toEqual([
        'min_price must be less than or equal to max_price',
      ]);
    });

    it('returns 400, not 500, when a param is repeated', async () => {
      const res = await request(app).get('/api/products?limit=1&limit=2');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('ignores unknown query params', async () => {
      const res = await listProducts({ utm_source: 'newsletter' });

      expect(res.status).toBe(200);
      expect(res.body.data.pagination.total).toBe(8);
    });
  });
});

describe('GET /api/products/:slug', () => {
  const getProduct = (slug: string) => request(app).get(`/api/products/${slug}`);

  it('returns the product with category, ordered images, and ordered variants, without auth', async () => {
    const res = await getProduct('alpha-headphones');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        id: 1,
        name: 'Alpha Headphones',
        slug: 'alpha-headphones',
        description: 'Alpha Headphones description',
        basePrice: 100,
        status: 'active',
        category: { id: 2, name: 'Audio', slug: 'audio' },
        images: [
          { id: 2, url: 'https://img.test/alpha-a.png' },
          { id: 3, url: 'https://img.test/alpha-b.png' },
          { id: 1, url: 'https://img.test/alpha-c.png' },
        ],
        // Cheapest first; the 100 tie is broken by id; stock is exposed only as inStock
        // (toEqual on the whole body also proves stockQuantity is not in the response).
        variants: [
          { id: 2, sku: 'ALPHA-BLK', price: 100, attributes: { color: 'Black' }, inStock: true },
          { id: 3, sku: 'ALPHA-WHT', price: 100, attributes: { color: 'White' }, inStock: true },
          { id: 1, sku: 'ALPHA-RED', price: 120, attributes: { color: 'Red' }, inStock: false },
        ],
      },
    });
  });

  it('returns empty images and variants arrays when a product has none', async () => {
    const res = await getProduct('beta-speaker');

    expect(res.body.data.images).toEqual([]);
    expect(res.body.data.variants).toEqual([]);
  });

  it('handles variants with null attributes', async () => {
    const res = await getProduct('gamma-phone');
    expect(res.body.data.variants).toEqual([
      { id: 4, sku: 'GAMMA-128', price: 500, attributes: null, inStock: true },
    ]);
  });

  it.each(['draft-headphones', 'archived-phone', 'does-not-exist'])(
    'returns 404 NOT_FOUND in the error envelope for %s',
    async (slug) => {
      const res = await getProduct(slug);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Product not found' },
      });
    },
  );

  it('returns 400 VALIDATION_ERROR for an over-long slug', async () => {
    const res = await getProduct('x'.repeat(201));

    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors).toHaveProperty('slug');
  });

  it('uses the standard error envelope for unmatched routes', async () => {
    const res = await request(app).get('/api/products/alpha-headphones/reviews');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });
});
