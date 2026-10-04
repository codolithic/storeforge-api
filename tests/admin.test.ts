import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import {
  inventoryReservations,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
  users,
} from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Catalog comes from fixtures/catalog.ts (slug `alpha-headphones`, SKU
// `ALPHA-RED` and categories 1-4 already exist). Orders are inserted directly
// with the status under test; each test uses its own customer so the admin
// order listing can be filtered down to exactly that test's rows.

type TestUser = { id: number; auth: string };
type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';

let userCounter = 0;
async function createUser(role: 'customer' | 'admin' = 'customer'): Promise<TestUser> {
  const [user] = await db
    .insert(users)
    .values({ email: `admin${++userCounter}@example.com`, passwordHash: 'not-used', role })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { id: user.id, auth: `Bearer ${signAccessToken({ sub: user.id, role: user.role })}` };
}

async function createOrder(
  userId: number,
  status: OrderStatus,
  { createdAt, held = false }: { createdAt?: string; held?: boolean } = {},
) {
  const [order] = await db
    .insert(orders)
    .values({
      userId,
      status,
      subtotal: 200,
      total: 200,
      ...(createdAt && { createdAt, updatedAt: createdAt }),
    })
    .returning();
  if (!order) throw new Error('failed to create order');
  await db.insert(orderItems).values({
    orderId: order.id,
    variantId: 2,
    productName: 'Alpha Headphones',
    variantAttributes: { color: 'Black' },
    unitPrice: 100,
    quantity: 2,
  });
  if (held) {
    await db.insert(inventoryReservations).values({
      orderId: order.id,
      variantId: 2,
      quantity: 2,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  }
  return order;
}

const orderRow = async (id: number) => {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
};

const productRow = async (id: number) => {
  const [row] = await db.select().from(products).where(eq(products.id, id));
  return row;
};

const createProduct = (auth: string, body: object) =>
  request(app).post('/api/admin/products').set('Authorization', auth).send(body);
const updateProduct = (auth: string, id: number | string, body: object) =>
  request(app).patch(`/api/admin/products/${id}`).set('Authorization', auth).send(body);
const listOrders = (auth: string, query = '') =>
  request(app).get(`/api/admin/orders${query}`).set('Authorization', auth);
const setStatus = (auth: string, id: number | string, status: string) =>
  request(app).patch(`/api/admin/orders/${id}/status`).set('Authorization', auth).send({ status });

let slugCounter = 0;
const newProduct = (overrides: object = {}) => {
  const n = ++slugCounter;
  return { name: `Product ${n}`, slug: `product-${n}`, basePrice: 10, ...overrides };
};

let admin: TestUser;

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  admin = await createUser('admin');
});

describe('authorization', () => {
  const routes = [
    ['POST', '/api/admin/products'],
    ['PATCH', '/api/admin/products/1'],
    ['GET', '/api/admin/orders'],
    ['PATCH', '/api/admin/orders/1/status'],
  ] as const;

  it.each(routes)('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each(routes)('%s %s returns 403 for a customer', async (method, path) => {
    const customer = await createUser();

    const res = await request(app)
      [method.toLowerCase() as 'get'](path)
      .set('Authorization', customer.auth);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('POST /api/admin/products', () => {
  it('creates a product with its variants and images', async () => {
    const res = await createProduct(admin.auth, {
      name: '  Omega Earbuds ',
      slug: ' Omega-Earbuds ',
      description: 'Tiny and loud',
      basePrice: 79,
      categoryId: 2,
      status: 'active',
      variants: [
        { sku: 'OMEGA-WHT', price: 89, attributes: { color: 'White' }, stockQuantity: 4 },
        { sku: 'OMEGA-BLK', price: 79 },
      ],
      images: [{ url: 'https://img.test/omega.png' }],
    });

    expect(res.status).toBe(201);
    const { product } = res.body.data;
    expect(res.body.data.message).toBe('Product created');
    expect(product).toEqual({
      id: expect.any(Number),
      name: 'Omega Earbuds',
      slug: 'omega-earbuds',
      description: 'Tiny and loud',
      basePrice: 79,
      status: 'active',
      createdAt: expect.any(String),
      updatedAt: product.createdAt,
      category: { id: 2, name: 'Audio', slug: 'audio' },
      images: [{ id: expect.any(Number), url: 'https://img.test/omega.png', position: 0 }],
      // Cheapest variant first; omitted attributes/stock default to null/0.
      variants: [
        { id: expect.any(Number), sku: 'OMEGA-BLK', price: 79, attributes: null, stockQuantity: 0 },
        {
          id: expect.any(Number),
          sku: 'OMEGA-WHT',
          price: 89,
          attributes: { color: 'White' },
          stockQuantity: 4,
        },
      ],
    });

    // An active product with variants is immediately in the public catalog.
    const publicRes = await request(app).get('/api/products/omega-earbuds');
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.data.variants.map((v: { inStock: boolean }) => v.inStock)).toEqual([
      false,
      true,
    ]);
  });

  it('defaults to a draft with no category, variants or images', async () => {
    const body = newProduct();

    const res = await createProduct(admin.auth, body);

    expect(res.status).toBe(201);
    expect(res.body.data.product).toMatchObject({
      slug: body.slug,
      description: null,
      status: 'draft',
      category: null,
      images: [],
      variants: [],
    });
    expect((await request(app).get(`/api/products/${body.slug}`)).status).toBe(404);
  });

  it('returns 409 SLUG_IN_USE for an existing slug', async () => {
    const res = await createProduct(admin.auth, newProduct({ slug: 'alpha-headphones' }));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_IN_USE');
  });

  it('returns 409 SKU_IN_USE and writes nothing when a variant SKU exists', async () => {
    const body = newProduct({
      variants: [
        { sku: 'FRESH-SKU', price: 10 },
        { sku: 'ALPHA-RED', price: 10 },
      ],
    });

    const res = await createProduct(admin.auth, body);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'SKU_IN_USE',
      message: 'SKU already in use: ALPHA-RED',
    });
    expect(await db.select().from(products).where(eq(products.slug, body.slug))).toEqual([]);
    expect(
      await db.select().from(productVariants).where(eq(productVariants.sku, 'FRESH-SKU')),
    ).toEqual([]);
  });

  it('returns 404 CATEGORY_NOT_FOUND for an unknown category', async () => {
    const res = await createProduct(admin.auth, newProduct({ categoryId: 999 }));

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it.each([
    ['missing name', { slug: 'no-name', basePrice: 1 }],
    ['a slug with spaces', newProduct({ slug: 'bad slug' })],
    ['a slug with symbols', newProduct({ slug: 'bad_slug!' })],
    ['a negative basePrice', newProduct({ basePrice: -1 })],
    ['an unknown status', newProduct({ status: 'deleted' })],
    [
      'duplicate SKUs in the body',
      newProduct({
        variants: [
          { sku: 'DUP', price: 1 },
          { sku: 'DUP', price: 2 },
        ],
      }),
    ],
    ['negative stock', newProduct({ variants: [{ sku: 'NEG', price: 1, stockQuantity: -1 }] })],
    ['an invalid image url', newProduct({ images: [{ url: 'not-a-url' }] })],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await createProduct(admin.auth, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/admin/products/:id', () => {
  async function draftProduct() {
    const res = await createProduct(
      admin.auth,
      newProduct({ variants: [{ sku: `SKU-${slugCounter}`, price: 10, stockQuantity: 3 }] }),
    );
    const id = res.body.data.product.id as number;
    // Back-date it so the updatedAt bump is observable at second resolution.
    await db
      .update(products)
      .set({ createdAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' })
      .where(eq(products.id, id));
    return res.body.data.product as { id: number; slug: string };
  }

  it('applies the given fields, echoes them and bumps updatedAt only', async () => {
    const product = await draftProduct();

    const res = await updateProduct(admin.auth, product.id, { name: 'Renamed', basePrice: 12.5 });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(`Product ${product.id} updated`);
    expect(res.body.data.changes).toEqual({ name: 'Renamed', basePrice: 12.5 });
    expect(res.body.data.product).toMatchObject({
      id: product.id,
      name: 'Renamed',
      basePrice: 12.5,
      slug: product.slug,
      status: 'draft',
      createdAt: '2026-01-01 00:00:00',
    });
    const row = await productRow(product.id);
    expect(row?.createdAt).toBe('2026-01-01 00:00:00');
    expect(row?.updatedAt).not.toBe('2026-01-01 00:00:00');
  });

  it('publishes a draft so it appears in the public catalog', async () => {
    const product = await draftProduct();
    expect((await request(app).get(`/api/products/${product.slug}`)).status).toBe(404);

    const res = await updateProduct(admin.auth, product.id, { status: 'active' });

    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/products/${product.slug}`)).status).toBe(200);
  });

  it('moves a product between categories and can clear it', async () => {
    const product = await draftProduct();

    const moved = await updateProduct(admin.auth, product.id, { categoryId: 4 });
    expect(moved.body.data.product.category).toEqual({ id: 4, name: 'Kitchen', slug: 'kitchen' });

    const cleared = await updateProduct(admin.auth, product.id, { categoryId: null });
    expect(cleared.body.data.product.category).toBeNull();
  });

  it('can edit products in any status', async () => {
    const res = await updateProduct(admin.auth, 10, { description: 'Archived but edited' });

    expect(res.status).toBe(200);
    expect(res.body.data.product).toMatchObject({
      status: 'archived',
      description: 'Archived but edited',
    });
  });

  it('allows keeping its own slug but rejects another product’s slug', async () => {
    const product = await draftProduct();

    expect((await updateProduct(admin.auth, product.id, { slug: product.slug })).status).toBe(200);

    const res = await updateProduct(admin.auth, product.id, { slug: 'alpha-headphones' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLUG_IN_USE');
    expect((await productRow(product.id))?.slug).toBe(product.slug);
  });

  it.each([
    ['an unknown product', 999999, { name: 'x' }, 'PRODUCT_NOT_FOUND'],
    ['an unknown category', 1, { categoryId: 999 }, 'CATEGORY_NOT_FOUND'],
  ])('returns 404 for %s', async (_label, id, body, code) => {
    const res = await updateProduct(admin.auth, id, body);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(code);
  });

  it.each([
    ['an empty body', 1, {}],
    ['only unknown fields', 1, { stockQuantity: 5 }],
    ['a blank name', 1, { name: '  ' }],
    ['a non-numeric id', 'abc', { name: 'x' }],
  ])('returns 400 for %s', async (_label, id, body) => {
    const res = await updateProduct(admin.auth, id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/admin/orders', () => {
  it('lists orders across users, newest first, including userId', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const older = await createOrder(alice.id, 'paid', { createdAt: '2026-03-01 10:00:00' });
    const newer = await createOrder(bob.id, 'pending', { createdAt: '2026-03-02 10:00:00' });

    const res = await listOrders(admin.auth, '?limit=100');

    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((o: { id: number }) => o.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
    const listed = res.body.data.items.find((o: { id: number }) => o.id === older.id);
    expect(listed).toEqual({
      id: older.id,
      userId: alice.id,
      status: 'paid',
      subtotal: 200,
      tax: 0,
      shippingFee: 0,
      total: 200,
      shippingAddressId: null,
      createdAt: '2026-03-01 10:00:00',
      updatedAt: '2026-03-01 10:00:00',
      shippingAddress: null,
      items: [
        {
          id: expect.any(Number),
          variantId: 2,
          productName: 'Alpha Headphones',
          variantAttributes: { color: 'Black' },
          unitPrice: 100,
          quantity: 2,
          lineTotal: 200,
        },
      ],
      itemCount: 2,
    });
  });

  it('filters by userId and status, and paginates', async () => {
    const user = await createUser();
    const a = await createOrder(user.id, 'paid', { createdAt: '2026-04-01 00:00:00' });
    await createOrder(user.id, 'pending', { createdAt: '2026-04-02 00:00:00' });
    const c = await createOrder(user.id, 'paid', { createdAt: '2026-04-03 00:00:00' });

    const byStatus = await listOrders(admin.auth, `?userId=${user.id}&status=paid`);
    expect(byStatus.body.data.items.map((o: { id: number }) => o.id)).toEqual([c.id, a.id]);

    const page2 = await listOrders(admin.auth, `?userId=${user.id}&page=2&limit=2`);
    expect(page2.body.data.items.map((o: { id: number }) => o.id)).toEqual([a.id]);
    expect(page2.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it.each([
    ['an unknown status', '?status=shipped'],
    ['a non-numeric userId', '?userId=abc'],
    ['limit above 100', '?limit=101'],
  ])('returns 400 for %s', async (_label, query) => {
    const res = await listOrders(admin.auth, query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/admin/orders/:id/status', () => {
  it('marks a paid order fulfilled and bumps updatedAt', async () => {
    const user = await createUser();
    const order = await createOrder(user.id, 'paid', { createdAt: '2026-05-01 00:00:00' });

    const res = await setStatus(admin.auth, order.id, 'fulfilled');

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe(`Order ${order.id} marked fulfilled`);
    expect(res.body.data.changes).toEqual({ status: { from: 'paid', to: 'fulfilled' } });
    expect(res.body.data.order).toMatchObject({
      id: order.id,
      userId: user.id,
      status: 'fulfilled',
    });
    const row = await orderRow(order.id);
    expect(row?.status).toBe('fulfilled');
    expect(row?.createdAt).toBe('2026-05-01 00:00:00');
    expect(row?.updatedAt).not.toBe('2026-05-01 00:00:00');
  });

  it('lets the customer review the product once the order is fulfilled', async () => {
    const user = await createUser();
    const order = await createOrder(user.id, 'paid');
    const review = () =>
      request(app)
        .post('/api/reviews')
        .set('Authorization', user.auth)
        .send({ productId: 1, rating: 5 });

    expect((await review()).status).toBe(403);
    await setStatus(admin.auth, order.id, 'fulfilled');
    expect((await review()).status).toBe(201);
  });

  it.each(['pending', 'fulfilled', 'cancelled', 'refunded'] as const)(
    'returns 409 INVALID_STATUS_TRANSITION fulfilling a %s order',
    async (status) => {
      const user = await createUser();
      const order = await createOrder(user.id, status);

      const res = await setStatus(admin.auth, order.id, 'fulfilled');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect((await orderRow(order.id))?.status).toBe(status);
    },
  );

  it('cancels a pending order and releases its stock holds', async () => {
    const user = await createUser();
    const order = await createOrder(user.id, 'pending', { held: true });

    const res = await setStatus(admin.auth, order.id, 'cancelled');

    expect(res.status).toBe(200);
    expect(res.body.data.changes).toEqual({ status: { from: 'pending', to: 'cancelled' } });
    expect((await orderRow(order.id))?.status).toBe('cancelled');
    expect(
      await db
        .select()
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, order.id)),
    ).toEqual([]);
  });

  it('returns 409 PAYMENT_IN_PROGRESS cancelling an order with a pending payment', async () => {
    const user = await createUser();
    const order = await createOrder(user.id, 'pending', { held: true });
    await db.insert(payments).values({ orderId: order.id, provider: 'stripe', amount: 200 });

    const res = await setStatus(admin.auth, order.id, 'cancelled');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    expect((await orderRow(order.id))?.status).toBe('pending');
  });

  it.each(['paid', 'fulfilled'] as const)(
    'returns 409 ORDER_NOT_CANCELLABLE pointing to refunds for a %s order',
    async (status) => {
      const user = await createUser();
      const order = await createOrder(user.id, status);

      const res = await setStatus(admin.auth, order.id, 'cancelled');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
      expect(res.body.error.message).toContain('refund');
      expect((await orderRow(order.id))?.status).toBe(status);
    },
  );

  it.each(['cancelled', 'refunded'] as const)(
    'returns 409 ORDER_NOT_CANCELLABLE for a %s order',
    async (status) => {
      const user = await createUser();
      const order = await createOrder(user.id, status);

      const res = await setStatus(admin.auth, order.id, 'cancelled');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
    },
  );

  it('returns 404 for an unknown order', async () => {
    const res = await setStatus(admin.auth, 999999, 'fulfilled');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it.each(['paid', 'refunded', 'pending', ''])(
    'returns 400 for target status "%s"',
    async (status) => {
      const res = await setStatus(admin.auth, 1, status);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );
});
