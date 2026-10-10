import { and, desc, eq } from 'drizzle-orm';
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
  payments,
  products,
  productVariants,
  users,
} from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Variants come from fixtures/catalog.ts, plus one inserted here so the
// status-changing test doesn't disturb the shared catalog rows:
//   2 ALPHA-BLK  100, stock raised to 1000 here (product 1 "Alpha Headphones",
//                { color: 'Black' }) so the purchases made by many tests never run it out
//   3 ALPHA-WHT  100, stock 2 (product 1)
//   4 GAMMA-128  500, stock 1 (product 3 "Gamma Phone", attributes null)
//   TOGGLE_VARIANT_ID  10, stock 10 (product 7, status flipped by one test)
// Stock-counting tests buy from their own variant via createVariant().
const TOGGLE_VARIANT_ID = 6;

// The simulated gateway's outcome is picked by the payment token.
const DECLINED_TOKEN = 'tok_decline';
const GATEWAY_ERROR_TOKEN = 'tok_gateway_error';

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

let variantCounter = 0;
async function createVariant(stockQuantity: number) {
  const [variant] = await db
    .insert(productVariants)
    .values({ productId: 2, sku: `ORD-${++variantCounter}`, price: 25, stockQuantity })
    .returning();
  if (!variant) throw new Error('failed to create variant');
  return variant.id;
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

// Checkout settles its payment in the same request, so a `pending` order only
// exists while a charge is in flight (or was interrupted). This writes one
// directly: the order, an active stock hold, and the pending payment.
async function createPendingOrder(userId: number, variantId = 2, quantity = 1) {
  const [order] = await db.insert(orders).values({ userId, subtotal: 100, total: 100 }).returning();
  if (!order) throw new Error('failed to create order');
  await db.insert(inventoryReservations).values({
    orderId: order.id,
    variantId,
    quantity,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  await db.insert(payments).values({ orderId: order.id, provider: 'stripe', amount: 100 });
  return order.id;
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

const orderStatus = async (orderId: number) => {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order?.status;
};

const stockOf = async (variantId: number) => {
  const [variant] = await db
    .select({ stockQuantity: productVariants.stockQuantity })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return variant?.stockQuantity;
};

const reservationsFor = (orderId: number) =>
  db.select().from(inventoryReservations).where(eq(inventoryReservations.orderId, orderId));

const holdStatuses = async (orderId: number) =>
  (await reservationsFor(orderId)).map(({ status, quantity }) => ({ status, quantity }));

const paymentsFor = (orderId: number) =>
  db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.id);

const latestOrderOf = async (userId: number) => {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.id))
    .limit(1);
  if (!order) throw new Error('no order was created');
  return order;
};

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  await db.insert(productVariants).values({
    id: TOGGLE_VARIANT_ID,
    productId: 7,
    sku: 'TOASTER-1',
    price: 10,
    stockQuantity: 10,
  });
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
  it('creates a paid order from the cart with snapshotted lines and totals', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [
      { variantId: 2, quantity: 2 },
      { variantId: 4, quantity: 1 },
    ]);

    const res = await checkout(auth);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      status: 'paid',
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
  });

  it('records one succeeded payment for the total, fulfils the holds and takes the stock', async () => {
    const { id, auth } = await createUser();
    const variantId = await createVariant(10);

    const orderId = await placeOrder(auth, id, variantId, 2);

    expect(await paymentsFor(orderId)).toEqual([
      {
        id: expect.any(Number),
        orderId,
        provider: 'stripe',
        providerRef: expect.stringMatching(/^pi_[a-z0-9]{16}$/),
        status: 'succeeded',
        amount: 50,
        createdAt: expect.any(String),
      },
    ]);
    expect(await holdStatuses(orderId)).toEqual([{ status: 'fulfilled', quantity: 2 }]);
    expect(await stockOf(variantId)).toBe(8);
  });

  it('charges through the requested provider', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    const res = await checkout(auth, { provider: 'paypal', paymentToken: 'tok_visa' });

    expect(res.status).toBe(201);
    expect(await paymentsFor(res.body.data.id)).toMatchObject([
      { provider: 'paypal', status: 'succeeded', providerRef: expect.stringMatching(/^PAYID-/) },
    ]);
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

  it('returns 402 PAYMENT_DECLINED, cancelling the order and reopening the cart', async () => {
    const { id, auth } = await createUser();
    const variantId = await createVariant(10);
    const cartId = await fillCart(id, [{ variantId, quantity: 2 }]);

    const res = await checkout(auth, { paymentToken: DECLINED_TOKEN });

    expect(res.status).toBe(402);
    expect(res.body.error).toEqual({ code: 'PAYMENT_DECLINED', message: 'Your card was declined' });
    const order = await latestOrderOf(id);
    expect(order.status).toBe('cancelled');
    expect(await paymentsFor(order.id)).toMatchObject([
      { status: 'failed', amount: 50, providerRef: expect.stringMatching(/^pi_/) },
    ]);
    expect(await holdStatuses(order.id)).toEqual([{ status: 'expired', quantity: 2 }]);
    expect(await stockOf(variantId)).toBe(10);
    const [cart] = await db.select().from(carts).where(eq(carts.id, cartId));
    expect(cart?.status).toBe('active');

    // The reopened cart can be checked out again as a new order.
    const retry = await checkout(auth);

    expect(retry.status).toBe(201);
    expect(retry.body.data).toMatchObject({ status: 'paid', total: 50 });
    expect(retry.body.data.id).not.toBe(order.id);
    expect(await stockOf(variantId)).toBe(8);
  });

  it('returns 502 PAYMENT_GATEWAY_ERROR and cancels the order when the gateway is down', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    const res = await checkout(auth, { paymentToken: GATEWAY_ERROR_TOKEN });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    const order = await latestOrderOf(id);
    expect(order.status).toBe('cancelled');
    expect(await paymentsFor(order.id)).toMatchObject([{ status: 'failed', providerRef: null }]);
    expect(await holdStatuses(order.id)).toEqual([{ status: 'expired', quantity: 1 }]);
  });

  it('leaves a newer active cart alone when a declined checkout reopens its cart', async () => {
    const { id, auth } = await createUser();
    const declinedCartId = await fillCart(id, [{ variantId: 2, quantity: 1 }]);

    await checkout(auth, { paymentToken: DECLINED_TOKEN });
    const [declinedCart] = await db.select().from(carts).where(eq(carts.id, declinedCartId));
    expect(declinedCart?.status).toBe('active');

    // With a second active cart in place, the next declined one stays converted.
    const newerCartId = await fillCart(id, [{ variantId: 2, quantity: 3 }]);
    await checkout(auth, { paymentToken: DECLINED_TOKEN });
    const [newerCart] = await db.select().from(carts).where(eq(carts.id, newerCartId));
    expect(newerCart?.status).toBe('converted');
  });

  it('charges the current variant price, not the cart snapshot', async () => {
    const { id, auth } = await createUser();
    await fillCart(id, [{ variantId: 3, quantity: 1, unitPriceSnapshot: 80 }]);

    const res = await checkout(auth);

    expect(res.body.data.items[0].unitPrice).toBe(100);
    expect(res.body.data.total).toBe(100);
    expect(await paymentsFor(res.body.data.id)).toMatchObject([{ amount: 100 }]);
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

  it("counts other pending orders' active reservations against stock", async () => {
    const variantId = await createVariant(3);
    const first = await createUser();
    const pendingOrder = await createPendingOrder(first.id, variantId, 2);
    const second = await createUser();
    await fillCart(second.id, [{ variantId, quantity: 2 }]);

    const blocked = await checkout(second.auth);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_STOCK');

    // Cancelling expires the hold, so the same cart can now check out.
    await cancelOrder(first.auth, pendingOrder);
    const retried = await checkout(second.auth);
    expect(retried.status).toBe(201);
  });

  it('ignores reservations past their expiry', async () => {
    const variantId = await createVariant(3);
    const first = await createUser();
    const pendingOrder = await createPendingOrder(first.id, variantId, 3);
    await db
      .update(inventoryReservations)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(inventoryReservations.orderId, pendingOrder));
    const second = await createUser();
    await fillCart(second.id, [{ variantId, quantity: 3 }]);

    const res = await checkout(second.auth);

    expect(res.status).toBe(201);
  });

  it('does not count fulfilled holds against stock for later checkouts', async () => {
    const { id, auth } = await createUser();
    const variantId = await createVariant(3);
    await placeOrder(auth, id, variantId, 1);
    expect(await stockOf(variantId)).toBe(2);

    // The fulfilled hold of 1 hasn't reached expiresAt yet; only the stock drop should count.
    await fillCart(id, [{ variantId, quantity: 2 }]);
    const res = await checkout(auth);

    expect(res.status).toBe(201);
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

  it.each([
    ['a non-integer shippingAddressId', { shippingAddressId: 'home' }],
    ['an unknown provider', { provider: 'venmo' }],
    ['a blank paymentToken', { paymentToken: '   ' }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_case, body) => {
    const { auth } = await createUser();

    const res = await checkout(auth, body);

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
    await fillCart(id, [{ variantId: 2, quantity: 1 }]);
    await checkout(auth, { paymentToken: DECLINED_TOKEN });

    const res = await listOrders(auth, '?status=paid');

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
      status: 'paid',
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
  it('cancels a pending order, failing its pending payment and expiring its holds', async () => {
    const { id, auth } = await createUser();
    const orderId = await createPendingOrder(id);

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: orderId, status: 'cancelled' });
    expect((await paymentsFor(orderId)).map((p) => p.status)).toEqual(['failed']);
    expect(await holdStatuses(orderId)).toEqual([{ status: 'expired', quantity: 1 }]);
  });

  it('returns 409 ORDER_NOT_CANCELLABLE when cancelling twice', async () => {
    const { id, auth } = await createUser();
    const orderId = await createPendingOrder(id);
    await cancelOrder(auth, orderId);

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_CANCELLABLE');
  });

  it('returns 409 for a paid order, leaving it and its payment unchanged', async () => {
    const { id, auth } = await createUser();
    const orderId = await placeOrder(auth, id);

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ORDER_NOT_CANCELLABLE',
      message: 'Order is paid and can no longer be cancelled',
    });
    expect(await orderStatus(orderId)).toBe('paid');
    expect((await paymentsFor(orderId)).map((p) => p.status)).toEqual(['succeeded']);
  });

  it("returns 404 for another user's order and does not cancel it", async () => {
    const owner = await createUser();
    const orderId = await createPendingOrder(owner.id);
    const { auth } = await createUser();

    const res = await cancelOrder(auth, orderId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.status, 'pending')));
    expect(order).toBeDefined();
    expect((await paymentsFor(orderId)).map((p) => p.status)).toEqual(['pending']);
  });
});
