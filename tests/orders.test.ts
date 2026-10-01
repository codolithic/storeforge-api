import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import {
  addresses,
  cartItems,
  carts,
  inventoryReservations,
  orders,
  products,
  productVariants,
  users,
} from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Variants come from fixtures/catalog.ts, plus two inserted here so stock-
// and status-changing tests don't disturb the shared catalog rows:
//   2 ALPHA-BLK  100, stock raised to 1000 here (product 1 "Alpha Headphones",
//                { color: 'Black' }) so the holds placed by many tests never run it out
//   3 ALPHA-WHT  100, stock 2 (product 1)
//   4 GAMMA-128  500, stock 1 (product 3 "Gamma Phone", attributes null)
//   SCARCE_VARIANT_ID  25, stock 3 (product 2 "Beta Speaker")
//   TOGGLE_VARIANT_ID  10, stock 10 (product 7, status flipped by one test)
const SCARCE_VARIANT_ID = 6;
const TOGGLE_VARIANT_ID = 7;

// Each test gets its own user, so carts and orders never leak between cases.
let userCounter = 0;
async function createUser() {
  const [user] = await db
    .insert(users)
    .values({ email: `orders${++userCounter}@example.com`, passwordHash: 'not-used' })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { id: user.id, auth: `Bearer ${signAccessToken({ sub: user.id, role: user.role })}` };
}

// Writes the cart rows directly; cart behaviour itself is covered in cart.test.ts.
async function fillCart(
  userId: number,
  lines: Array<{ variantId: number; quantity: number; unitPriceSnapshot?: number }>,
) {
  const [cart] = await db.insert(carts).values({ userId }).returning();
  if (!cart) throw new Error('failed to create cart');
  await db
    .insert(cartItems)
    .values(lines.map((line) => ({ unitPriceSnapshot: 1, ...line, cartId: cart.id })));
  return cart.id;
}

async function createAddress(userId: number, isDefault = false) {
  const [address] = await db
    .insert(addresses)
    .values({
      userId,
      line1: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
      isDefault,
    })
    .returning();
  if (!address) throw new Error('failed to create address');
  return address;
}

const checkout = (auth: string, body?: object) => {
  const req = request(app).post('/api/orders').set('Authorization', auth);
  return body ? req.send(body) : req;
};
const listOrders = (auth: string, query = '') =>
  request(app).get(`/api/orders${query}`).set('Authorization', auth);
const getOrder = (auth: string, id: number | string) =>
  request(app).get(`/api/orders/${id}`).set('Authorization', auth);
const cancelOrder = (auth: string, id: number | string) =>
  request(app).post(`/api/orders/${id}/cancel`).set('Authorization', auth);

async function placeOrder(auth: string, userId: number, variantId = 2, quantity = 1) {
  await fillCart(userId, [{ variantId, quantity }]);
  const res = await checkout(auth);
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

const reservationsFor = (orderId: number) =>
  db.select().from(inventoryReservations).where(eq(inventoryReservations.orderId, orderId));

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  await db.insert(productVariants).values([
    { id: SCARCE_VARIANT_ID, productId: 2, sku: 'BETA-1', price: 25, stockQuantity: 3 },
    { id: TOGGLE_VARIANT_ID, productId: 7, sku: 'TOASTER-1', price: 10, stockQuantity: 10 },
  ]);
  await db.update(productVariants).set({ stockQuantity: 1000 }).where(eq(productVariants.id, 2));
});

describe('authentication', () => {
  it.each([
    ['POST', '/api/orders'],
    ['GET', '/api/orders'],
    ['GET', '/api/orders/1'],
    ['POST', '/api/orders/1/cancel'],
  ])('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/orders', () => {
  it('creates a pending order from the cart with snapshotted lines and totals', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [
      { variantId: 2, quantity: 2 },
      { variantId: 4, quantity: 1 },
    ]);

    const res = await checkout(auth);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      status: 'pending',
      subtotal: 700,
      tax: 0,
      shippingFee: 0,
      total: 700,
      shippingAddress: null,
      itemCount: 3,
      items: [
        {
          variantId: 2,
          productName: 'Alpha Headphones',
          variantAttributes: { color: 'Black' },
          unitPrice: 100,
          quantity: 2,
          lineTotal: 200,
        },
        {
          variantId: 4,
          productName: 'Gamma Phone',
          variantAttributes: null,
          unitPrice: 500,
          quantity: 1,
          lineTotal: 500,
        },
      ],
    });
    expect(res.body.data).not.toHaveProperty('userId');

    // Stock is held, not decremented.
    const orderId = res.body.data.id as number;
    const holds = await reservationsFor(orderId);
    expect(holds.map(({ variantId, quantity }) => ({ variantId, quantity }))).toEqual([
      { variantId: 2, quantity: 2 },
      { variantId: 4, quantity: 1 },
    ]);
    expect(new Date(holds[0]!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const [gamma] = await db.select().from(productVariants).where(eq(productVariants.id, 4));
    expect(gamma?.stockQuantity).toBe(1);

    // Release the Gamma hold so later tests can still buy the single unit.
    await cancelOrder(auth, orderId);
  });

  it('converts the cart, so the next cart read is empty', async () => {
    const { id, auth } = await createUser();
    const cartId = await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    await checkout(auth);

    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('converted');
    const cartRes = await request(app).get('/api/cart').set('Authorization', auth);
    expect(cartRes.body.data.items).toEqual([]);
  });

  it('charges the current variant price, not the cart snapshot', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [{ variantId: 3, quantity: 1, unitPriceSnapshot: 80 }]);

    const res = await checkout(auth);

    expect(res.body.data.items[0].unitPrice).toBe(100);
    expect(res.body.data.total).toBe(100);
  });

  it('keeps the snapshot when the catalog changes after purchase', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id, TOGGLE_VARIANT_ID);

    await db
      .update(productVariants)
      .set({ price: 99 })
      .where(eq(productVariants.id, TOGGLE_VARIANT_ID));
    await db.update(products).set({ name: 'Renamed Toaster' }).where(eq(products.id, 7));

    const res = await getOrder(auth, orderId);
    expect(res.body.data.items[0]).toMatchObject({ productName: 'Toaster_Pro', unitPrice: 10 });

    await db
      .update(productVariants)
      .set({ price: 10 })
      .where(eq(productVariants.id, TOGGLE_VARIANT_ID));
    await db.update(products).set({ name: 'Toaster_Pro' }).where(eq(products.id, 7));
  });

  it('uses the given shipping address', async () => {
    const { id, auth } = await createUser();
    await createAddress(id, true);
    const address = await createAddress(id);
    await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    const res = await checkout(auth, { shippingAddressId: address.id });

    expect(res.status).toBe(201);
    expect(res.body.data.shippingAddress).toEqual({
      id: address.id,
      line1: '1 Main St',
      line2: null,
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
  });

  it("falls back to the user's default address", async () => {
    const { id, auth } = await createUser();
    await createAddress(id);
    const defaultAddress = await createAddress(id, true);
    await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    const res = await checkout(auth);

    expect(res.body.data.shippingAddress.id).toBe(defaultAddress.id);
  });

  it("returns 404 ADDRESS_NOT_FOUND for another user's address, keeping the cart", async () => {
    const other = await createUser();
    const foreign = await createAddress(other.id, true);
    const { id, auth } = await createUser();
    const cartId = await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    const res = await checkout(auth, { shippingAddressId: foreign.id });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADDRESS_NOT_FOUND');
    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('active');
  });

  it('returns 400 CART_EMPTY when the user has no cart', async () => {
    const { auth } = await createUser();

    const res = await checkout(auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CART_EMPTY');
  });

  it('returns 400 CART_EMPTY for an active cart with no items', async () => {
    const { id, auth } = await createUser();
    await db.insert(carts).values({ userId: id });

    const res = await checkout(auth);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CART_EMPTY');
  });

  it('returns 409 INSUFFICIENT_STOCK when a line exceeds stock, creating nothing', async () => {
    const { id, auth } = await createUser();
    const cartId = await fillCart(id, [
      { variantId: 2, quantity: 1 },
      { variantId: 3, quantity: 3 },
    ]);

    const res = await checkout(auth);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await db.select().from(orders).where(eq(orders.userId, id))).toEqual([]);
    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('active');
  });

  it("counts other pending orders' reservations against stock", async () => {
    const first = await createUser();
    const firstOrder = await placeOrder(first.auth, first.id, SCARCE_VARIANT_ID, 2);
    const second = await createUser();
    await fillCart(second.id, [{ variantId: SCARCE_VARIANT_ID, quantity: 2 }]);

    const blocked = await checkout(second.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_STOCK');

    // Cancelling releases the hold, so the same cart can now check out.
    await cancelOrder(first.auth, firstOrder);
    const retried = await checkout(second.auth);
    expect(retried.status).toBe(201);
    await cancelOrder(second.auth, retried.body.data.id);
  });

  it('ignores expired reservations', async () => {
    const first = await createUser();
    const firstOrder = await placeOrder(first.auth, first.id, SCARCE_VARIANT_ID, 3);
    await db
      .update(inventoryReservations)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(inventoryReservations.orderId, firstOrder));
    const second = await createUser();
    await fillCart(second.id, [{ variantId: SCARCE_VARIANT_ID, quantity: 3 }]);

    const res = await checkout(second.auth);

    expect(res.status).toBe(201);
    await cancelOrder(second.auth, res.body.data.id);
  });

  it('returns 409 ITEM_UNAVAILABLE when a product is no longer active', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [{ variantId: TOGGLE_VARIANT_ID, quantity: 1 }]);
    await db.update(products).set({ status: 'archived' }).where(eq(products.id, 7));

    const res = await checkout(auth);

    await db.update(products).set({ status: 'active' }).where(eq(products.id, 7));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
  });

  it('returns 400 VALIDATION_ERROR for a non-integer shippingAddressId', async () => {
    const { auth } = await createUser();

    const res = await checkout(auth, { shippingAddressId: 'home' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/orders', () => {
  it("lists only the caller's orders, newest first, with pagination", async () => {
    const other = await createUser();
    await placeOrder(other.auth, other.id);
    const { id, auth } = await createUser();
    const ids = [
      await placeOrder(auth, id),
      await placeOrder(auth, id),
      await placeOrder(auth, id),
    ];

    const res = await listOrders(auth, '?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.data.items.map((o: { id: number }) => o.id)).toEqual([ids[2], ids[1]]);
    expect(res.body.data.items[0].items).toHaveLength(1);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });

    const page2 = await listOrders(auth, '?limit=2&page=2');
    expect(page2.body.data.items.map((o: { id: number }) => o.id)).toEqual([ids[0]]);
  });

  it('filters by status', async () => {
    const { id, auth } = await createUser();
    const kept = await placeOrder(auth, id);
    const cancelled = await placeOrder(auth, id);
    await cancelOrder(auth, cancelled);

    const res = await listOrders(auth, '?status=pending');

    expect(res.body.data.items.map((o: { id: number }) => o.id)).toEqual([kept]);
    expect(res.body.data.pagination.total).toBe(1);
  });

  it('returns an empty page for a user with no orders', async () => {
    const { auth } = await createUser();

    const res = await listOrders(auth);

    expect(res.body.data).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('returns 400 VALIDATION_ERROR for an unknown status', async () => {
    const { auth } = await createUser();

    const res = await listOrders(auth, '?status=shipped');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/orders/:id', () => {
  it('returns the order with its items', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id, 2, 2);

    const res = await getOrder(auth, orderId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: orderId,
      status: 'pending',
      total: 200,
      itemCount: 2,
      items: [{ variantId: 2, quantity: 2, unitPrice: 100, lineTotal: 200 }],
    });
  });

  it("returns 404 for another user's order", async () => {
    const owner = await createUser();
    const orderId = await placeOrder(owner.auth, owner.id);
    const { auth } = await createUser();

    const res = await getOrder(auth, orderId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR for a non-numeric id', async () => {
    const { auth } = await createUser();

    const res = await getOrder(auth, 'abc');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/orders/:id/cancel', () => {
  it('cancels a pending order and releases its reservations', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id);
    expect(await reservationsFor(orderId)).toHaveLength(1);

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: orderId, status: 'cancelled' });
    expect(await reservationsFor(orderId)).toEqual([]);
  });

  it('returns 409 ORDER_NOT_CANCELLABLE when cancelling twice', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id);
    await cancelOrder(auth, orderId);

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('returns 409 for an order that is already paid, leaving it unchanged', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id);
    await db.update(orders).set({ status: 'paid' }).where(eq(orders.id, orderId));

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ORDER_NOT_CANCELLABLE',
      message: 'Order is paid and can no longer be cancelled',
    });
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order?.status).toBe('paid');
  });

  it("returns 404 for another user's order and does not cancel it", async () => {
    const owner = await createUser();
    const orderId = await placeOrder(owner.auth, owner.id);
    const { auth } = await createUser();

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending')));
    expect(order).toBeDefined();
  });
});
