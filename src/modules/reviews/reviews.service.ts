import { and, count, desc, eq, getTableColumns } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { orderItems, orders, products, productVariants, reviews, users } from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import type {
  CreateReviewInput,
  ListMyReviewsQuery,
  ListReviewsQuery,
  UpdateReviewInput,
} from './reviews.types.js';

const reviewColumns = getTableColumns(reviews);

// Public reviews show "First L." rather than the full name or any user id.
function displayName(firstName: string | null, lastName: string | null) {
  const initial = lastName?.trim().charAt(0);
  const name = [firstName?.trim(), initial ? `${initial.toUpperCase()}.` : undefined]
    .filter(Boolean)
    .join(' ');
  return name || 'Anonymous';
}

function paginate(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// Reviews of non-active products are hidden along with the product itself.
export async function listProductReviews(query: ListReviewsQuery) {
  const product = db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, query.productId), eq(products.status, 'active')))
    .get();
  if (!product) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }

  const where = and(
    eq(reviews.productId, query.productId),
    query.rating ? eq(reviews.rating, query.rating) : undefined,
  );

  const rows = await db
    .select({
      id: reviews.id,
      productId: reviews.productId,
      rating: reviews.rating,
      comment: reviews.comment,
      createdAt: reviews.createdAt,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(where)
    // Tie-break on id so pages stay stable when timestamps repeat.
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(reviews).where(where);

  return {
    items: rows.map(({ firstName, lastName, ...review }) => ({
      ...review,
      reviewer: displayName(firstName, lastName),
    })),
    pagination: paginate(query.page, query.limit, total),
  };
}

export async function listMyReviews(userId: number, query: ListMyReviewsQuery) {
  const where = eq(reviews.userId, userId);

  const items = await db
    .select({ ...reviewColumns, productName: products.name, productSlug: products.slug })
    .from(reviews)
    .innerJoin(products, eq(products.id, reviews.productId))
    .where(where)
    .orderBy(desc(reviews.createdAt), desc(reviews.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(reviews).where(where);

  return { items, pagination: paginate(query.page, query.limit, total) };
}

// A user may review an active product once, and only after receiving it in a
// `fulfilled` order (pending/paid/cancelled/refunded orders don't count). The
// schema has no unique (userId, productId) index, so the duplicate check and
// insert run in one synchronous better-sqlite3 transaction to rule out races.
export async function createReview(userId: number, input: CreateReviewInput) {
  return db.transaction((tx) => {
    const product = tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.status, 'active')))
      .get();
    if (!product) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const existing = tx
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.userId, userId), eq(reviews.productId, input.productId)))
      .get();
    if (existing) {
      throw new ApiError(409, 'REVIEW_EXISTS', 'You have already reviewed this product');
    }

    const purchase = tx
      .select({ orderId: orders.id })
      .from(orders)
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(productVariants, eq(productVariants.id, orderItems.variantId))
      .where(
        and(
          eq(orders.userId, userId),
          eq(orders.status, 'fulfilled'),
          eq(productVariants.productId, input.productId),
        ),
      )
      .get();
    if (!purchase) {
      throw new ApiError(
        403,
        'REVIEW_NOT_ALLOWED',
        'You can only review products from your fulfilled orders',
      );
    }

    // createdAt is left to the column default.
    return tx
      .insert(reviews)
      .values({
        userId,
        productId: input.productId,
        rating: input.rating,
        comment: input.comment ?? null,
      })
      .returning()
      .get();
  });
}

// Only the author can edit a review; anyone else's is a 404. Reviews have no
// updatedAt column, so there is no timestamp to touch.
export async function updateReview(userId: number, reviewId: number, input: UpdateReviewInput) {
  const review = db
    .update(reviews)
    .set({ rating: input.rating, comment: input.comment })
    .where(and(eq(reviews.id, reviewId), eq(reviews.userId, userId)))
    .returning()
    .get();
  if (!review) {
    throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  }
  return review;
}

// Authors can delete their own review; admins can delete any (moderation).
export async function deleteReview(
  user: { id: number; role: 'customer' | 'admin' },
  reviewId: number,
) {
  const deleted = db
    .delete(reviews)
    .where(
      and(
        eq(reviews.id, reviewId),
        user.role === 'admin' ? undefined : eq(reviews.userId, user.id),
      ),
    )
    .returning({ id: reviews.id })
    .get();
  if (!deleted) {
    throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
  }
  return deleted;
}
