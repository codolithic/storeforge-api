import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { orderItems, orders, productVariants, reviews, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';
import { seedCatalog } from './fixtures/catalog.js';

// Products come from fixtures/catalog.ts: product 1 "Alpha Headphones"
// (variants 1-3), product 3 "Gamma Phone" (variant 4), product 9 is a draft.
// Product 2 "Beta Speaker" is reserved for the listing tests, whose reviews are
// inserted directly with fixed timestamps so the expected order is exact.
const DRAFT_VARIANT_ID = 100;

type TestUser = { id: number; auth: string };

let userCounter = 0;
async function createUser(
  role: 'customer' | 'admin' = 'customer',
  name: { firstName?: string | null; lastName?: string | null } = {},
): Promise<TestUser> {
  const [user] = await db
    .insert(users)
    .values({
      email: `reviews${++userCounter}@example.com`,
      passwordHash: 'not-used',
      role,
      firstName: name.firstName ?? null,
      lastName: name.lastName ?? null,
    })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { id: user.id, auth: `Bearer ${signAccessToken({ sub: user.id, role: user.role })}` };
}

type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';

// Orders are inserted directly: only their status and line variants matter here.
async function createOrder(userId: number, status: OrderStatus, variantIds: number[]) {
  const [order] = await db
    .insert(orders)
    .values({ userId, status, subtotal: 100, total: 100 })
    .returning();
  if (!order) throw new Error('failed to create order');
  await db.insert(orderItems).values(
    variantIds.map((variantId) => ({
      orderId: order.id,
      variantId,
      productName: 'snapshot',
      unitPrice: 100,
      quantity: 1,
    })),
  );
  return order.id;
}

async function buyerOf(variantId: number, name?: { firstName?: string; lastName?: string }) {
  const user = await createUser('customer', name);
  await createOrder(user.id, 'fulfilled', [variantId]);
  return user;
}

const reviewRow = async (id: number) => {
  const [row] = await db.select().from(reviews).where(eq(reviews.id, id));
  return row;
};

const listReviews = (query: string) => request(app).get(`/api/reviews${query}`);
const listMine = (auth: string, query = '') =>
  request(app).get(`/api/reviews/me${query}`).set('Authorization', auth);
const createReview = (auth: string, body: object) =>
  request(app).post('/api/reviews').set('Authorization', auth).send(body);
const updateReview = (auth: string, id: number | string, body: object) =>
  request(app).patch(`/api/reviews/${id}`).set('Authorization', auth).send(body);
const deleteReview = (auth: string, id: number | string) =>
  request(app).delete(`/api/reviews/${id}`).set('Authorization', auth);

let admin: TestUser;
// Ids of the product-2 reviews, newest first: [jane (5★), anon (3★), bob (5★)].
let listingIds: number[];

beforeAll(async () => {
  migrateTestDb();
  await seedCatalog();
  await db
    .insert(productVariants)
    .values({ id: DRAFT_VARIANT_ID, productId: 9, sku: 'DRAFT-1', price: 120, stockQuantity: 5 });
  admin = await createUser('admin');

  const bob = await createUser('customer', { firstName: 'Bob', lastName: 'smith' });
  const anon = await createUser('customer');
  const jane = await createUser('customer', { firstName: 'Jane', lastName: 'Doe' });
  const inserted = await db
    .insert(reviews)
    .values([
      {
        productId: 2,
        userId: bob.id,
        rating: 5,
        comment: 'Loud',
        createdAt: '2026-01-01 10:00:00',
      },
      { productId: 2, userId: anon.id, rating: 3, comment: null, createdAt: '2026-01-02 10:00:00' },
      {
        productId: 2,
        userId: jane.id,
        rating: 5,
        comment: 'Great',
        createdAt: '2026-01-03 10:00:00',
      },
    ])
    .returning({ id: reviews.id });
  listingIds = inserted.map((r) => r.id).reverse();
});

describe('authentication', () => {
  it.each([
    ['GET', '/api/reviews/me'],
    ['POST', '/api/reviews'],
    ['PATCH', '/api/reviews/1'],
    ['DELETE', '/api/reviews/1'],
  ])('%s %s returns 401 without a bearer token', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get'](path);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('GET /api/reviews is public', async () => {
    const res = await listReviews('?productId=2');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/reviews', () => {
  it('lists a product’s reviews newest first with a public reviewer name', async () => {
    const res = await listReviews('?productId=2');

    expect(res.body).toEqual({
      success: true,
      data: {
        items: [
          {
            id: listingIds[0],
            productId: 2,
            rating: 5,
            comment: 'Great',
            createdAt: '2026-01-03 10:00:00',
            reviewer: 'Jane D.',
          },
          {
            id: listingIds[1],
            productId: 2,
            rating: 3,
            comment: null,
            createdAt: '2026-01-02 10:00:00',
            reviewer: 'Anonymous',
          },
          {
            id: listingIds[2],
            productId: 2,
            rating: 5,
            comment: 'Loud',
            createdAt: '2026-01-01 10:00:00',
            reviewer: 'Bob S.',
          },
        ],
        pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
      },
    });
  });

  it('filters by rating', async () => {
    const res = await listReviews('?productId=2&rating=5');

    expect(res.body.data.items.map((r: { id: number }) => r.id)).toEqual([
      listingIds[0],
      listingIds[2],
    ]);
    expect(res.body.data.pagination.total).toBe(2);
  });

  it('paginates', async () => {
    const res = await listReviews('?productId=2&page=2&limit=2');

    expect(res.body.data.items.map((r: { id: number }) => r.id)).toEqual([listingIds[2]]);
    expect(res.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('returns an empty page for an active product without reviews', async () => {
    const res = await listReviews('?productId=8');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
  });

  it.each([
    ['a draft product', 9],
    ['an archived product', 10],
    ['an unknown product', 9999],
  ])('returns 404 for %s', async (_label, productId) => {
    const res = await listReviews(`?productId=${productId}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each([
    ['missing productId', ''],
    ['non-numeric productId', '?productId=abc'],
    ['rating above 5', '?productId=2&rating=6'],
    ['limit above 100', '?productId=2&limit=101'],
  ])('returns 400 for %s', async (_label, query) => {
    const res = await listReviews(query);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/reviews', () => {
  it('creates a review for a product from a fulfilled order', async () => {
    const user = await buyerOf(2);

    const res = await createReview(user.auth, { productId: 1, rating: 4, comment: '  Comfy  ' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      productId: 1,
      userId: user.id,
      rating: 4,
      comment: 'Comfy',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
    expect(await reviewRow(res.body.data.id)).toEqual(res.body.data);
  });

  it('accepts a review without a comment', async () => {
    const user = await buyerOf(4);

    const res = await createReview(user.auth, { productId: 3, rating: 2 });

    expect(res.status).toBe(201);
    expect(res.body.data.comment).toBeNull();
  });

  it('counts any variant of the product as a purchase', async () => {
    const user = await buyerOf(3);

    const res = await createReview(user.auth, { productId: 1, rating: 5 });

    expect(res.status).toBe(201);
  });

  it('allows the purchase to come from any of several fulfilled orders', async () => {
    const user = await createUser();
    await createOrder(user.id, 'cancelled', [2]);
    await createOrder(user.id, 'fulfilled', [4, 2]);

    const res = await createReview(user.auth, { productId: 1, rating: 5 });

    expect(res.status).toBe(201);
  });

  it.each(['pending', 'paid', 'cancelled', 'refunded'] as const)(
    'returns 403 when the product was only in a %s order',
    async (status) => {
      const user = await createUser();
      await createOrder(user.id, status, [2]);

      const res = await createReview(user.auth, { productId: 1, rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REVIEW_NOT_ALLOWED');
    },
  );

  it('returns 403 when a fulfilled order contained a different product', async () => {
    const user = await buyerOf(4);

    const res = await createReview(user.auth, { productId: 1, rating: 5 });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REVIEW_NOT_ALLOWED');
  });

  it('does not count another user’s fulfilled order', async () => {
    await buyerOf(2);
    const user = await createUser();

    const res = await createReview(user.auth, { productId: 1, rating: 5 });

    expect(res.status).toBe(403);
  });

  it('returns 409 for a second review of the same product, even from a later order', async () => {
    const user = await buyerOf(2);
    expect((await createReview(user.auth, { productId: 1, rating: 5 })).status).toBe(201);
    await createOrder(user.id, 'fulfilled', [3]);

    const res = await createReview(user.auth, { productId: 1, rating: 1 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REVIEW_EXISTS');
    const mine = await db.select().from(reviews).where(eq(reviews.userId, user.id));
    expect(mine).toHaveLength(1);
  });

  it.each([
    ['a draft product', 9],
    ['an unknown product', 9999],
  ])('returns 404 for %s', async (_label, productId) => {
    const user = await buyerOf(DRAFT_VARIANT_ID);

    const res = await createReview(user.auth, { productId, rating: 5 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });

  it.each([
    ['missing rating', { productId: 1 }],
    ['rating below 1', { productId: 1, rating: 0 }],
    ['rating above 5', { productId: 1, rating: 6 }],
    ['fractional rating', { productId: 1, rating: 4.5 }],
    ['string productId', { productId: '1', rating: 4 }],
    ['blank comment', { productId: 1, rating: 4, comment: '   ' }],
    ['comment over 2000 chars', { productId: 1, rating: 4, comment: 'x'.repeat(2001) }],
  ])('returns 400 for %s', async (_label, body) => {
    const user = await buyerOf(2);

    const res = await createReview(user.auth, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/reviews/me', () => {
  it('lists only the caller’s reviews, newest first, with product name and slug', async () => {
    const user = await createUser();
    await createOrder(user.id, 'fulfilled', [2, 4]);
    const first = await createReview(user.auth, { productId: 1, rating: 4 });
    const second = await createReview(user.auth, { productId: 3, rating: 5, comment: 'Fast' });
    // Both rows can share a second-resolution createdAt, so pin them apart.
    await db
      .update(reviews)
      .set({ createdAt: '2026-02-01 00:00:00' })
      .where(eq(reviews.id, first.body.data.id));

    const res = await listMine(user.auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        {
          ...second.body.data,
          productName: 'Gamma Phone',
          productSlug: 'gamma-phone',
        },
        {
          ...first.body.data,
          createdAt: '2026-02-01 00:00:00',
          productName: 'Alpha Headphones',
          productSlug: 'alpha-headphones',
        },
      ],
      pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
  });

  it('returns an empty page for a user without reviews', async () => {
    const user = await createUser();

    const res = await listMine(user.auth, '?limit=5');

    expect(res.body.data).toEqual({
      items: [],
      pagination: { page: 1, limit: 5, total: 0, totalPages: 0 },
    });
  });
});

describe('PATCH /api/reviews/:id', () => {
  async function ownReview() {
    const user = await buyerOf(2);
    const res = await createReview(user.auth, { productId: 1, rating: 3, comment: 'Okay' });
    return { user, review: res.body.data };
  }

  it('updates the rating only', async () => {
    const { user, review } = await ownReview();

    const res = await updateReview(user.auth, review.id, { rating: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ...review, rating: 5 });
    expect(await reviewRow(review.id)).toEqual({ ...review, rating: 5 });
  });

  it('updates the comment and keeps createdAt', async () => {
    const { user, review } = await ownReview();

    const res = await updateReview(user.auth, review.id, { comment: 'Better than expected' });

    expect(res.body.data).toEqual({ ...review, comment: 'Better than expected' });
  });

  it('clears the comment with null', async () => {
    const { user, review } = await ownReview();

    const res = await updateReview(user.auth, review.id, { comment: null });

    expect(res.status).toBe(200);
    expect(res.body.data.comment).toBeNull();
  });

  it('returns 404 for another user’s review, even for an admin, and leaves it unchanged', async () => {
    const { review } = await ownReview();
    const other = await createUser();

    for (const auth of [other.auth, admin.auth]) {
      const res = await updateReview(auth, review.id, { rating: 1 });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
    }
    expect(await reviewRow(review.id)).toEqual(review);
  });

  it('returns 404 for an unknown review', async () => {
    const user = await createUser();

    const res = await updateReview(user.auth, 999999, { rating: 1 });

    expect(res.status).toBe(404);
  });

  it.each([
    ['an empty body', {}],
    ['rating above 5', { rating: 6 }],
    ['blank comment', { comment: '' }],
  ])('returns 400 for %s', async (_label, body) => {
    const { user, review } = await ownReview();

    const res = await updateReview(user.auth, review.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for a non-numeric id', async () => {
    const user = await createUser();

    const res = await updateReview(user.auth, 'abc', { rating: 1 });

    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/reviews/:id', () => {
  async function ownReview() {
    const user = await buyerOf(2);
    const res = await createReview(user.auth, { productId: 1, rating: 3 });
    return { user, reviewId: res.body.data.id as number };
  }

  it('lets the author delete their review, after which they may review again', async () => {
    const { user, reviewId } = await ownReview();

    const res = await deleteReview(user.auth, reviewId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { id: reviewId } });
    expect(await reviewRow(reviewId)).toBeUndefined();
    expect((await createReview(user.auth, { productId: 1, rating: 4 })).status).toBe(201);
  });

  it('lets an admin delete any review', async () => {
    const { reviewId } = await ownReview();

    const res = await deleteReview(admin.auth, reviewId);

    expect(res.status).toBe(200);
    expect(await reviewRow(reviewId)).toBeUndefined();
  });

  it('returns 404 for another customer’s review and keeps it', async () => {
    const { reviewId } = await ownReview();
    const other = await createUser();

    const res = await deleteReview(other.auth, reviewId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
    expect(await reviewRow(reviewId)).toBeDefined();
  });

  it('returns 404 when deleting an already deleted review', async () => {
    const { user, reviewId } = await ownReview();
    await deleteReview(user.auth, reviewId);

    const res = await deleteReview(user.auth, reviewId);

    expect(res.status).toBe(404);
  });
});
