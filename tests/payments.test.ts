import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { cartItems, carts, orders, payments, productVariants, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Products come from fixtures/catalog.ts; each test buys from its own variant
// (inserted under product 2 "Beta Speaker", price 25) so stock assertions never
// depend on other tests. Payments are created by checkout (POST /api/orders),
// whose charge is covered in orders.test.ts; the simulated gateway's outcome is
// picked by token.
const OK_TOKEN = 'tok_visa';
const DECLINED_TOKEN = 'tok_decline';

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

const paymentsFor = (orderId: number) =>
  db.select().from(payments).where(eq(payments.orderId, orderId)).orderBy(payments.id);

// Checks out a fresh cart through the real orders route, so the order has a
// genuine payment row. Returns the order, its first payment and the variant bought.
async function placeOrder(
  user: { id: number; auth: string },
  {
    provider = 'stripe',
    paymentToken = OK_TOKEN,
  }: { provider?: string; paymentToken?: string } = {},
) {
  const variantId = await createVariant();
  const [cart] = await db.insert(carts).values({ userId: user.id }).returning();
  if (!cart) throw new Error('failed to create cart');
  await db
    .insert(cartItems)
    .values({ cartId: cart.id, variantId, quantity: 2, unitPriceSnapshot: 25 });
  await request(app)
    .post('/api/orders')
    .set('Authorization', user.auth)
    .send({ provider, paymentToken });
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.id))
    .limit(1);
  if (!order) throw new Error('checkout created no order');
  const [payment] = await paymentsFor(order.id);
  if (!payment) throw new Error('checkout created no payment');
  return { orderId: order.id, paymentId: payment.id, variantId };
}

async function placePaidOrder(user: { id: number; auth: string }, provider = 'stripe') {
  const placed = await placeOrder(user, { provider });
  expect(await orderStatus(placed.orderId)).toBe('paid');
  return placed;
}

const listPayments = (auth: string, query = '') =>
  request(app).get(`/api/payments${query}`).set('Authorization', auth);
const getPayment = (auth: string, id: number | string) =>
  request(app).get(`/api/payments/${id}`).set('Authorization', auth);
const refund = (auth: string, id: number | string) =>
  request(app).post(`/api/payments/${id}/refund`).set('Authorization', auth);

let admin: { id: number; auth: string };

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  admin = await createUser('admin');
});

describe('authentication', () => {
  it.each([
    ['GET', '/api/payments'],
    ['GET', '/api/payments/1'],
    ['POST', '/api/payments/1/refund'],
  ])('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/payments', () => {
  it("lists only the caller's payments, newest first, with pagination", async () => {
    const user = await createUser();
    const declined = await placeOrder(user, { paymentToken: DECLINED_TOKEN });
    const paid = await placePaidOrder(user, 'paypal');
    await placePaidOrder(await createUser());

    const res = await listPayments(user.auth, '?limit=1');

    expect(res.status).toBe(200);
    expect(res.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
    expect(res.body.data.items).toMatchObject([
      { orderId: paid.orderId, provider: 'paypal', status: 'succeeded' },
    ]);
    expect(declined.orderId).not.toBe(paid.orderId);

    const page2 = await listPayments(user.auth, '?limit=1&page=2');
    expect(page2.body.data.items).toMatchObject([{ provider: 'stripe', status: 'failed' }]);
  });

  it('filters by orderId and status', async () => {
    const user = await createUser();
    const a = await placePaidOrder(user);
    const b = await placeOrder(user, { paymentToken: DECLINED_TOKEN });

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
    const { orderId, paymentId } = await placeOrder(await createUser(), {
      paymentToken: DECLINED_TOKEN,
    });

    const res = await refund(admin.auth, paymentId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
    expect(await orderStatus(orderId)).toBe('cancelled');
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
