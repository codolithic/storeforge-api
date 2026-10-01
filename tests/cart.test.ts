import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { cartItems, carts, productVariants, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Variants used below come from fixtures/catalog.ts:
//   1 ALPHA-RED  120, stock 0 (product 1, active)
//   2 ALPHA-BLK  100, stock 5 (product 1, active)
//   3 ALPHA-WHT  100, stock 2 (product 1, active)
//   4 GAMMA-128  500, stock 1 (product 3, active)
// plus DRAFT_VARIANT_ID, inserted here on draft product 9.
const DRAFT_VARIANT_ID = 5;

// Each test gets its own user, so carts never leak between cases.
let userCounter = 0;
async function createUser() {
  const [user] = await db
    .insert(users)
    .values({ email: `cart${++userCounter}@example.com`, passwordHash: 'not-used' })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { id: user.id, auth: `Bearer ${signAccessToken({ sub: user.id, role: user.role })}` };
}

const getCart = (auth: string) => request(app).get('/api/cart').set('Authorization', auth);
const addItem = (auth: string, body: object) =>
  request(app).post('/api/cart/items').set('Authorization', auth).send(body);
const updateItem = (auth: string, id: number | string, body: object) =>
  request(app).patch(`/api/cart/items/${id}`).set('Authorization', auth).send(body);
const removeItem = (auth: string, id: number | string) =>
  request(app).delete(`/api/cart/items/${id}`).set('Authorization', auth);

async function addAndGetItemId(auth: string, body: object) {
  const res = await addItem(auth, body);
  expect(res.status).toBe(201);
  const item = res.body.data.items.at(-1);
  return item.id as number;
}

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  await db.insert(productVariants).values({
    id: DRAFT_VARIANT_ID,
    productId: 9,
    sku: 'DRAFT-1',
    price: 10,
    stockQuantity: 10,
  });
});

describe('authentication', () => {
  it.each([
    ['GET', '/api/cart'],
    ['POST', '/api/cart/items'],
    ['PATCH', '/api/cart/items/1'],
    ['DELETE', '/api/cart/items/1'],
  ])('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header' },
    });
  });

  it('returns 401 for an invalid access token', async () => {
    const res = await getCart('Bearer not-a-jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/cart', () => {
  it('returns an empty cart without creating one when the user has none', async () => {
    const user = await createUser();
    const res = await getCart(user.auth);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { id: null, items: [], itemCount: 0, subtotal: 0 },
    });
    expect(await db.select().from(carts).where(eq(carts.userId, user.id))).toHaveLength(0);
  });

  it('returns items with variant and product details, line totals and the subtotal', async () => {
    const user = await createUser();
    await addItem(user.auth, { variantId: 2, quantity: 2 });
    await addItem(user.auth, { variantId: 4 });

    const res = await getCart(user.auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      items: [
        {
          id: expect.any(Number),
          variantId: 2,
          sku: 'ALPHA-BLK',
          attributes: { color: 'Black' },
          product: { id: 1, name: 'Alpha Headphones', slug: 'alpha-headphones' },
          quantity: 2,
          unitPriceSnapshot: 100,
          lineTotal: 200,
          available: true,
        },
        {
          id: expect.any(Number),
          variantId: 4,
          sku: 'GAMMA-128',
          attributes: null,
          product: { id: 3, name: 'Gamma Phone', slug: 'gamma-phone' },
          quantity: 1,
          unitPriceSnapshot: 500,
          lineTotal: 500,
          available: true,
        },
      ],
      itemCount: 3,
      subtotal: 700,
    });
  });

  it("only returns the caller's own cart", async () => {
    const owner = await createUser();
    const other = await createUser();
    await addItem(owner.auth, { variantId: 2 });

    const res = await getCart(other.auth);

    expect(res.body.data.items).toEqual([]);
  });

  it('ignores carts that are no longer active', async () => {
    const user = await createUser();
    const added = await addItem(user.auth, { variantId: 2 });
    await db.update(carts).set({ status: 'converted' }).where(eq(carts.id, added.body.data.id));

    const res = await getCart(user.auth);

    expect(res.body.data).toEqual({ id: null, items: [], itemCount: 0, subtotal: 0 });
  });

  it('keeps the price snapshot when the variant price changes, and flags unavailable lines', async () => {
    const user = await createUser();
    await db.insert(productVariants).values({
      id: 100,
      productId: 2,
      sku: 'BETA-TEMP',
      price: 40,
      stockQuantity: 3,
    });
    await addItem(user.auth, { variantId: 100, quantity: 3 });
    await db
      .update(productVariants)
      .set({ price: 45, stockQuantity: 1 })
      .where(eq(productVariants.id, 100));

    const res = await getCart(user.auth);

    expect(res.body.data.items[0]).toMatchObject({
      unitPriceSnapshot: 40,
      lineTotal: 120,
      available: false,
    });
  });
});

describe('POST /api/cart/items', () => {
  it('creates the cart and the line, returning 201 with the cart', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: 3, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ itemCount: 2, subtotal: 200 });
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      variantId: 3,
      quantity: 2,
      unitPriceSnapshot: 100,
    });

    const userCarts = await db.select().from(carts).where(eq(carts.userId, user.id));
    expect(userCarts).toMatchObject([{ id: res.body.data.id, status: 'active' }]);
  });

  it('defaults quantity to 1', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: 2 });

    expect(res.status).toBe(201);
    expect(res.body.data.items[0].quantity).toBe(1);
  });

  it('reuses the active cart for further items', async () => {
    const user = await createUser();
    const first = await addItem(user.auth, { variantId: 2 });
    const second = await addItem(user.auth, { variantId: 4 });

    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.items.map((i: { variantId: number }) => i.variantId)).toEqual([2, 4]);
    expect(await db.select().from(carts).where(eq(carts.userId, user.id))).toHaveLength(1);
  });

  it('merges a repeated variant into the existing line and returns 200', async () => {
    const user = await createUser();
    await addItem(user.auth, { variantId: 2, quantity: 2 });
    const res = await addItem(user.auth, { variantId: 2, quantity: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ variantId: 2, quantity: 5 });
  });

  it('refreshes the price snapshot when a repeated variant is merged', async () => {
    const user = await createUser();
    await db.insert(productVariants).values({
      id: 101,
      productId: 2,
      sku: 'BETA-MERGE',
      price: 40,
      stockQuantity: 10,
    });
    await addItem(user.auth, { variantId: 101 });
    await db.update(productVariants).set({ price: 42 }).where(eq(productVariants.id, 101));

    const res = await addItem(user.auth, { variantId: 101 });

    expect(res.body.data.items[0]).toMatchObject({
      quantity: 2,
      unitPriceSnapshot: 42,
      lineTotal: 84,
    });
  });

  it('returns 409 INSUFFICIENT_STOCK for an out-of-stock variant', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('returns 409 when the requested quantity exceeds stock', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: 3, quantity: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('returns 409 when merging would exceed stock, leaving the line unchanged', async () => {
    const user = await createUser();
    await addItem(user.auth, { variantId: 3, quantity: 2 });
    const res = await addItem(user.auth, { variantId: 3 });

    expect(res.status).toBe(409);
    expect((await getCart(user.auth)).body.data.items[0].quantity).toBe(2);
  });

  it('returns 400 QUANTITY_LIMIT_EXCEEDED when merging would exceed 99 units', async () => {
    const user = await createUser();
    await db.insert(productVariants).values({
      id: 102,
      productId: 2,
      sku: 'BETA-BULK',
      price: 1,
      stockQuantity: 1000,
    });
    await addItem(user.auth, { variantId: 102, quantity: 99 });
    const res = await addItem(user.auth, { variantId: 102 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('QUANTITY_LIMIT_EXCEEDED');
  });

  it('returns 404 for an unknown variant without creating a cart', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: 9999 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
    expect(await db.select().from(carts).where(eq(carts.userId, user.id))).toHaveLength(0);
  });

  it('returns 404 for a variant of a non-active product', async () => {
    const user = await createUser();
    const res = await addItem(user.auth, { variantId: DRAFT_VARIANT_ID });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VARIANT_NOT_FOUND');
  });

  it.each([
    ['missing variantId', {}],
    ['non-integer variantId', { variantId: 1.5 }],
    ['string variantId', { variantId: '2' }],
    ['zero quantity', { variantId: 2, quantity: 0 }],
    ['negative quantity', { variantId: 2, quantity: -1 }],
    ['quantity over 99', { variantId: 2, quantity: 100 }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_case, body) => {
    const user = await createUser();
    const res = await addItem(user.auth, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/cart/items/:id', () => {
  it('sets the quantity and returns the updated cart, keeping the price snapshot', async () => {
    const user = await createUser();
    const itemId = await addAndGetItemId(user.auth, { variantId: 2 });

    const res = await updateItem(user.auth, itemId, { quantity: 4 });

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ id: itemId, quantity: 4, unitPriceSnapshot: 100, lineTotal: 400 }),
    ]);
    expect(res.body.data).toMatchObject({ itemCount: 4, subtotal: 400 });
  });

  it('can lower the quantity', async () => {
    const user = await createUser();
    const itemId = await addAndGetItemId(user.auth, { variantId: 2, quantity: 5 });

    const res = await updateItem(user.auth, itemId, { quantity: 1 });

    expect(res.status).toBe(200);
    expect(res.body.data.items[0].quantity).toBe(1);
  });

  it('returns 409 INSUFFICIENT_STOCK when the quantity exceeds stock', async () => {
    const user = await createUser();
    const itemId = await addAndGetItemId(user.auth, { variantId: 3 });

    const res = await updateItem(user.auth, itemId, { quantity: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it("returns 404 for another user's item and leaves it unchanged", async () => {
    const owner = await createUser();
    const other = await createUser();
    const itemId = await addAndGetItemId(owner.auth, { variantId: 2 });

    const res = await updateItem(other.auth, itemId, { quantity: 3 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_ITEM_NOT_FOUND');
    const [row] = await db.select().from(cartItems).where(eq(cartItems.id, itemId));
    expect(row?.quantity).toBe(1);
  });

  it('returns 404 for an unknown item', async () => {
    const user = await createUser();
    const res = await updateItem(user.auth, 9999, { quantity: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_ITEM_NOT_FOUND');
  });

  it.each([
    ['missing quantity', 1, {}],
    ['zero quantity', 1, { quantity: 0 }],
    ['quantity over 99', 1, { quantity: 100 }],
    ['non-numeric id', 'abc', { quantity: 1 }],
    ['zero id', 0, { quantity: 1 }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_case, id, body) => {
    const user = await createUser();
    const res = await updateItem(user.auth, id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('DELETE /api/cart/items/:id', () => {
  it('removes the line and returns the remaining cart', async () => {
    const user = await createUser();
    const removedId = await addAndGetItemId(user.auth, { variantId: 2 });
    await addItem(user.auth, { variantId: 4 });

    const res = await removeItem(user.auth, removedId);

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((i: { variantId: number }) => i.variantId)).toEqual([4]);
    expect(res.body.data).toMatchObject({ itemCount: 1, subtotal: 500 });
  });

  it('keeps the now-empty cart', async () => {
    const user = await createUser();
    const itemId = await addAndGetItemId(user.auth, { variantId: 2 });

    const res = await removeItem(user.auth, itemId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      items: [],
      itemCount: 0,
      subtotal: 0,
    });
  });

  it('returns 404 when removing the same item twice', async () => {
    const user = await createUser();
    const itemId = await addAndGetItemId(user.auth, { variantId: 2 });
    await removeItem(user.auth, itemId);

    const res = await removeItem(user.auth, itemId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('CART_ITEM_NOT_FOUND');
  });

  it("returns 404 for another user's item and does not delete it", async () => {
    const owner = await createUser();
    const other = await createUser();
    const itemId = await addAndGetItemId(owner.auth, { variantId: 2 });

    const res = await removeItem(other.auth, itemId);

    expect(res.status).toBe(404);
    expect(await db.select().from(cartItems).where(eq(cartItems.id, itemId))).toHaveLength(1);
  });

  it('returns 400 VALIDATION_ERROR for a non-numeric id', async () => {
    const user = await createUser();
    const res = await removeItem(user.auth, 'abc');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
