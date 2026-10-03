import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import {
  cartItems,
  carts,
  inventoryReservations,
  orders,
  payments,
  productVariants,
  users,
} from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Products come from fixtures/catalog.ts; each test buys from its own variant
// (inserted under product 2 "Beta Speaker", price 25) so stock assertions never
// depend on other tests. The simulated gateway's outcome is picked by token.
const OK_TOKEN = 'tok_visa';
const DECLINED_TOKEN = 'tok_declined';
const GATEWAY_ERROR_TOKEN = 'tok_gateway_error';

let userCounter = 0;
async function createUser(role: 'customer' | 'admin' = 'customer') {
  const [user] = await db
    .insert(users)
    .values({ email: `payments${++userCounter}@example.com`, passwordHash: 'not-used', role })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { id: user.id, auth: `Bearer ${signAccessToken({ sub: user.id, role: user.role })}` };
}

let variantCounter = 0;
async function createVariant(stockQuantity = 10) {
  const [variant] = await db
    .insert(productVariants)
    .values({ productId: 2, sku: `PAY-${++variantCounter}`, price: 25, stockQuantity })
    .returning();
  if (!variant) throw new Error('failed to create variant');
  return variant.id;
}

const stockOf = async (variantId: number) => {
  const [variant] = await db
    .select({ stockQuantity: productVariants.stockQuantity })
    .from(productVariants)
    .where(eq(productVariants.id, variantId));
  return variant?.stockQuantity;
};

const orderStatus = async (orderId: number) => {
  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId));
  return order?.status;
};

const reservationsFor = (orderId: number) =>
  db
    .select({ status: inventoryReservations.status, quantity: inventoryReservations.quantity })
    .from(inventoryReservations)
    .where(eq(inventoryReservations.orderId, orderId));

const paymentsFor = (orderId: number) =>
  db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.id);

// Checks out a fresh cart through the real orders route, so the order has
// genuine reservations. Returns the pending order id and the variant bought.
async function placeOrder(
  user: { id: number; auth: string },
  { quantity = 2, stock = 10 }: { quantity?: number; stock?: number } = {},
) {
  const variantId = await createVariant(stock);
  const [cart] = await db.insert(carts).values({ userId: user.id }).returning();
  if (!cart) throw new Error('failed to create cart');
  await db
    .insert(cartItems)
    .values({ cartId: cart.id, variantId, quantity, unitPriceSnapshot: 25 });
  const res = await request(app).post('/api/orders').set('Authorization', user.auth);
  expect(res.status).toBe(201);
  return { orderId: res.body.data.id as number, variantId };
}

const pay = (auth: string, body: object) =>
  request(app).post('/api/payments').set('Authorization', auth).send(body);
const listPayments = (auth: string, query = '') =>
  request(app).get(`/api/payments${query}`).set('Authorization', auth);
const getPayment = (auth: string, id: number | string) =>
  request(app).get(`/api/payments/${id}`).set('Authorization', auth);
const refund = (auth: string, id: number | string) =>
  request(app).post(`/api/payments/${id}/refund`).set('Authorization', auth);

async function placePaidOrder(user: { id: number; auth: string }, provider = 'stripe') {
  const placed = await placeOrder(user);
  const res = await pay(user.auth, { orderId: placed.orderId, provider, paymentToken: OK_TOKEN });
  expect(res.status).toBe(201);
  return { ...placed, paymentId: res.body.data.id as number };
}

let admin: { id: number; auth: string };

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  admin = await createUser('admin');
});

describe('authentication', () => {
  it.each([
    ['POST', '/api/payments'],
    ['GET', '/api/payments'],
    ['GET', '/api/payments/1'],
    ['POST', '/api/payments/1/refund'],
  ])('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('POST /api/payments', () => {
  it('charges the order total, marks the order paid and turns holds into a stock decrement', async () => {
    const user = await createUser();
    const { orderId, variantId } = await placeOrder(user, { quantity: 2, stock: 10 });

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      orderId,
      provider: 'stripe',
      providerRef: expect.stringMatching(/^pi_[a-z0-9]{16}$/),
      status: 'succeeded',
      amount: 50,
      createdAt: expect.any(String),
    });
    expect(await orderStatus(orderId)).toBe('paid');
    expect(await reservationsFor(orderId)).toEqual([{ status: 'fulfilled', quantity: 2 }]);
    expect(await stockOf(variantId)).toBe(8);
  });

  it('issues PayPal-style references for PayPal', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);

    const res = await pay(user.auth, { orderId, provider: 'paypal', paymentToken: OK_TOKEN });

    expect(res.status).toBe(201);
    expect(res.body.data.providerRef).toMatch(/^PAYID-[A-Z0-9]{8}$/);
  });

  it('returns 402 PAYMENT_DECLINED, records a failed payment and keeps the order payable', async () => {
    const user = await createUser();
    const { orderId, variantId } = await placeOrder(user, { quantity: 2, stock: 10 });

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: DECLINED_TOKEN });

    expect(res.status).toBe(402);
    expect(res.body.error).toEqual({ code: 'PAYMENT_DECLINED', message: 'Your card was declined' });
    expect(await paymentsFor(orderId)).toMatchObject([
      { status: 'failed', amount: 50, providerRef: expect.stringMatching(/^pi_/) },
    ]);
    expect(await orderStatus(orderId)).toBe('pending');
    expect(await reservationsFor(orderId)).toEqual([{ status: 'active', quantity: 2 }]);
    expect(await stockOf(variantId)).toBe(10);

    const retry = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(retry.status).toBe(201);
    expect(await orderStatus(orderId)).toBe('paid');
    expect((await paymentsFor(orderId)).map((p) => p.status)).toEqual(['failed', 'succeeded']);
  });

  it('returns 502 PAYMENT_GATEWAY_ERROR and marks the attempt failed when the gateway is down', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);

    const res = await pay(user.auth, {
      orderId,
      provider: 'stripe',
      paymentToken: GATEWAY_ERROR_TOKEN,
    });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect(await paymentsFor(orderId)).toMatchObject([{ status: 'failed', providerRef: null }]);
    expect(await orderStatus(orderId)).toBe('pending');
  });

  it('returns 409 ORDER_NOT_PAYABLE for an order that is already paid', async () => {
    const user = await createUser();
    const { orderId } = await placePaidOrder(user);

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ORDER_NOT_PAYABLE',
      message: 'Order is paid and cannot be paid',
    });
    expect(await paymentsFor(orderId)).toHaveLength(1);
  });

  it('returns 409 ORDER_NOT_PAYABLE for a cancelled order', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);
    await request(app).post(`/api/orders/${orderId}/cancel`).set('Authorization', user.auth);

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ORDER_NOT_PAYABLE');
  });

  it('returns 409 PAYMENT_IN_PROGRESS while another payment is pending', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);
    await db.insert(payments).values({ orderId, provider: 'stripe', amount: 50 });

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    expect(await orderStatus(orderId)).toBe('pending');
  });

  it('blocks cancelling the order while a payment is pending', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);
    await db.insert(payments).values({ orderId, provider: 'stripe', amount: 50 });

    const res = await request(app)
      .post(`/api/orders/${orderId}/cancel`)
      .set('Authorization', user.auth);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_IN_PROGRESS');
    expect(await orderStatus(orderId)).toBe('pending');
  });

  it('returns 409 CHECKOUT_EXPIRED and cancels the order once its holds have lapsed', async () => {
    const user = await createUser();
    const { orderId, variantId } = await placeOrder(user);
    await db
      .update(inventoryReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(inventoryReservations.orderId, orderId));

    const res = await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CHECKOUT_EXPIRED');
    expect(await orderStatus(orderId)).toBe('cancelled');
    expect(await reservationsFor(orderId)).toEqual([{ status: 'expired', quantity: 2 }]);
    expect(await paymentsFor(orderId)).toEqual([]);
    expect(await stockOf(variantId)).toBe(10);
  });

  it('does not count fulfilled holds against stock for later checkouts', async () => {
    const user = await createUser();
    const { orderId, variantId } = await placeOrder(user, { quantity: 1, stock: 3 });
    await pay(user.auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });
    expect(await stockOf(variantId)).toBe(2);

    // The fulfilled hold of 1 hasn't reached expiresAt yet; only the stock drop should count.
    const [cart] = await db.insert(carts).values({ userId: user.id }).returning();
    await db
      .insert(cartItems)
      .values({ cartId: cart!.id, variantId, quantity: 2, unitPriceSnapshot: 25 });
    const res = await request(app).post('/api/orders').set('Authorization', user.auth);

    expect(res.status).toBe(201);
  });

  it("returns 404 ORDER_NOT_FOUND for another user's order", async () => {
    const owner = await createUser();
    const { orderId } = await placeOrder(owner);
    const { auth } = await createUser();

    const res = await pay(auth, { orderId, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    expect(await orderStatus(orderId)).toBe('pending');
  });

  it('returns 404 ORDER_NOT_FOUND for an unknown order', async () => {
    const { auth } = await createUser();

    const res = await pay(auth, { orderId: 999_999, provider: 'stripe', paymentToken: OK_TOKEN });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it.each([
    ['a missing paymentToken', { orderId: 1, provider: 'stripe' }],
    ['a blank paymentToken', { orderId: 1, provider: 'stripe', paymentToken: '   ' }],
    ['an unknown provider', { orderId: 1, provider: 'venmo', paymentToken: OK_TOKEN }],
    ['a non-integer orderId', { orderId: 1.5, provider: 'stripe', paymentToken: OK_TOKEN }],
    ['a string orderId', { orderId: '1', provider: 'stripe', paymentToken: OK_TOKEN }],
  ])('returns 400 VALIDATION_ERROR for %s', async (_case, body) => {
    const { auth } = await createUser();

    const res = await pay(auth, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/payments', () => {
  it("lists only the caller's payments, newest first, with pagination", async () => {
    const user = await createUser();
    const first = await placeOrder(user);
    await pay(user.auth, {
      orderId: first.orderId,
      provider: 'stripe',
      paymentToken: DECLINED_TOKEN,
    });
    await pay(user.auth, { orderId: first.orderId, provider: 'paypal', paymentToken: OK_TOKEN });
    await placePaidOrder(await createUser());

    const res = await listPayments(user.auth, '?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(res.body.data.items).toMatchObject([
      { orderId: first.orderId, provider: 'paypal', status: 'succeeded' },
    ]);

    const page2 = await listPayments(user.auth, '?limit=1&page=2');
    expect(page2.body.data.items).toMatchObject([{ provider: 'stripe', status: 'failed' }]);
  });

  it('filters by orderId and status', async () => {
    const user = await createUser();
    const a = await placePaidOrder(user);
    const b = await placeOrder(user);
    await pay(user.auth, { orderId: b.orderId, provider: 'stripe', paymentToken: DECLINED_TOKEN });

    const byOrder = await listPayments(user.auth, `?orderId=${a.orderId}`);
    const byStatus = await listPayments(user.auth, '?status=failed');

    expect(byOrder.body.data.items.map((p: { id: number }) => p.id)).toEqual([a.paymentId]);
    expect(byStatus.body.data.items).toMatchObject([{ orderId: b.orderId, status: 'failed' }]);
  });

  it('returns an empty page for a user with no payments', async () => {
    const { auth } = await createUser();

    const res = await listPayments(auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it('returns 400 VALIDATION_ERROR for an unknown status', async () => {
    const { auth } = await createUser();

    const res = await listPayments(auth, '?status=settled');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/payments/:id', () => {
  it('returns the payment', async () => {
    const user = await createUser();
    const { orderId, paymentId } = await placePaidOrder(user);

    const res = await getPayment(user.auth, paymentId);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: paymentId, orderId, status: 'succeeded' });
  });

  it("returns 404 PAYMENT_NOT_FOUND for another user's payment", async () => {
    const { paymentId } = await placePaidOrder(await createUser());
    const { auth } = await createUser();

    const res = await getPayment(auth, paymentId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('returns 400 VALIDATION_ERROR for a non-numeric id', async () => {
    const { auth } = await createUser();

    const res = await getPayment(auth, 'abc');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/payments/:id/refund', () => {
  it('refunds a paid order as a new payment row and puts the units back in stock', async () => {
    const user = await createUser();
    const { orderId, variantId, paymentId } = await placePaidOrder(user);
    expect(await stockOf(variantId)).toBe(8);

    const res = await refund(admin.auth, paymentId);

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      orderId,
      provider: 'stripe',
      providerRef: expect.stringMatching(/^re_[a-z0-9]{16}$/),
      status: 'refunded',
      amount: 50,
      createdAt: expect.any(String),
    });
    expect(res.body.data.id).not.toBe(paymentId);
    expect((await paymentsFor(orderId)).map((p) => p.status)).toEqual(['succeeded', 'refunded']);
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(await stockOf(variantId)).toBe(10);
  });

  it('refunds a fulfilled order without restocking', async () => {
    const user = await createUser();
    const { orderId, variantId, paymentId } = await placePaidOrder(user, 'paypal');
    await db.update(orders).set({ status: 'fulfilled' }).where(eq(orders.id, orderId));

    const res = await refund(admin.auth, paymentId);

    expect(res.status).toBe(201);
    expect(res.body.data.providerRef).toMatch(/^REFUND-[A-Z0-9]{8}$/);
    expect(await orderStatus(orderId)).toBe('refunded');
    expect(await stockOf(variantId)).toBe(8);
  });

  it('returns 409 ORDER_NOT_REFUNDABLE when refunding twice', async () => {
    const { orderId, paymentId } = await placePaidOrder(await createUser());
    await refund(admin.auth, paymentId);

    const res = await refund(admin.auth, paymentId);

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'ORDER_NOT_REFUNDABLE',
      message: 'Order is refunded and cannot be refunded',
    });
    expect(await paymentsFor(orderId)).toHaveLength(2);
  });

  it('returns 409 PAYMENT_NOT_REFUNDABLE for a failed payment', async () => {
    const user = await createUser();
    const { orderId } = await placeOrder(user);
    await pay(user.auth, { orderId, provider: 'stripe', paymentToken: DECLINED_TOKEN });
    const [failed] = await paymentsFor(orderId);

    const res = await refund(admin.auth, failed!.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
    expect(await orderStatus(orderId)).toBe('pending');
  });

  it('returns 404 PAYMENT_NOT_FOUND for an unknown payment', async () => {
    const res = await refund(admin.auth, 999_999);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('returns 403 FORBIDDEN for a customer, even on their own payment', async () => {
    const user = await createUser();
    const { orderId, paymentId } = await placePaidOrder(user);

    const res = await refund(user.auth, paymentId);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await orderStatus(orderId)).toBe('paid');
  });
});
