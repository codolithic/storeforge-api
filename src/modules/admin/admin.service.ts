import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { categories, orders, productImages, products, productVariants } from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import { cancelPendingOrder, formatOrder, orderWith, type Tx } from '../orders/orders.service.js';
import type {
  CreateProductInput,
  ListAdminOrdersQuery,
  UpdateOrderStatusInput,
  UpdateProductInput,
} from './admin.types.js';

const touchedNow = sql`(current_timestamp)`;

/* ---------------------------------------------------------------- products */

function assertSlugFree(tx: Tx, slug: string, exceptProductId?: number) {
  const taken = tx
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.slug, slug),
        exceptProductId === undefined ? undefined : ne(products.id, exceptProductId),
      ),
    )
    .get();
  if (taken) {
    throw new ApiError(409, 'SLUG_IN_USE', `Slug "${slug}" is already used by another product`);
  }
}

function assertCategoryExists(tx: Tx, categoryId: number | null | undefined) {
  if (categoryId === null || categoryId === undefined) return;
  const category = tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .get();
  if (!category) {
    throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
  }
}

// Unlike the public catalog, admins see products in every status, with raw
// stock counts and timestamps.
async function getProduct(productId: number) {
  const product = await db.query.products.findFirst({
    columns: { categoryId: false },
    where: eq(products.id, productId),
    with: {
      category: { columns: { id: true, name: true, slug: true } },
      images: {
        columns: { id: true, url: true, position: true },
        orderBy: [asc(productImages.position), asc(productImages.id)],
      },
      variants: {
        columns: { productId: false },
        orderBy: [asc(productVariants.price), asc(productVariants.id)],
      },
    },
  });
  if (!product) {
    throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
  }
  return product;
}

// Product, variants and images are written in one synchronous transaction, so
// the uniqueness checks can't race and a failure leaves nothing behind.
// createdAt/updatedAt are left to the column defaults.
export async function createProduct(input: CreateProductInput) {
  const { variants, images, ...fields } = input;

  const productId = db.transaction((tx) => {
    assertSlugFree(tx, fields.slug);
    assertCategoryExists(tx, fields.categoryId);

    if (variants.length > 0) {
      const takenSkus = tx
        .select({ sku: productVariants.sku })
        .from(productVariants)
        .where(
          inArray(
            productVariants.sku,
            variants.map((v) => v.sku),
          ),
        )
        .all();
      if (takenSkus.length > 0) {
        throw new ApiError(
          409,
          'SKU_IN_USE',
          `SKU already in use: ${takenSkus.map((v) => v.sku).join(', ')}`,
        );
      }
    }

    const { id } = tx.insert(products).values(fields).returning({ id: products.id }).get();
    if (variants.length > 0) {
      tx.insert(productVariants)
        .values(variants.map((variant) => ({ ...variant, productId: id })))
        .run();
    }
    if (images.length > 0) {
      tx.insert(productImages)
        .values(images.map((image) => ({ ...image, productId: id })))
        .run();
    }
    return id;
  });

  return { message: 'Product created', product: await getProduct(productId) };
}

// `changes` echoes the fields that were applied; `product` is the result.
export async function updateProduct(productId: number, input: UpdateProductInput) {
  db.transaction((tx) => {
    const existing = tx
      .select({ id: products.id })
      .from(products)
      .where(eq(products.id, productId))
      .get();
    if (!existing) {
      throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }
    if (input.slug !== undefined) assertSlugFree(tx, input.slug, productId);
    assertCategoryExists(tx, input.categoryId);

    tx.update(products)
      .set({ ...input, updatedAt: touchedNow })
      .where(eq(products.id, productId))
      .run();
  });

  return {
    message: `Product ${productId} updated`,
    changes: input,
    product: await getProduct(productId),
  };
}

/* ------------------------------------------------------------------ orders */

const adminOrderQuery = { with: orderWith } as const;

export async function listOrders(query: ListAdminOrdersQuery) {
  const where = and(
    query.status ? eq(orders.status, query.status) : undefined,
    query.userId ? eq(orders.userId, query.userId) : undefined,
  );

  const rows = await db.query.orders.findMany({
    ...adminOrderQuery,
    where,
    // Tie-break on id so pages stay stable when timestamps repeat.
    orderBy: [desc(orders.createdAt), desc(orders.id)],
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  });

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(orders).where(where);

  return {
    items: rows.map(formatOrder),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

async function getOrder(orderId: number) {
  const order = await db.query.orders.findFirst({
    ...adminOrderQuery,
    where: eq(orders.id, orderId),
  });
  if (!order) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  return formatOrder(order);
}

// Admins move orders along the parts of the flow that happen outside the app:
//   paid → fulfilled   the order has been shipped/delivered
//   pending → cancelled same rules as a customer cancel (no payment in flight;
//                       stock holds released)
// Money never moves here: a paid order is cancelled by refunding its payment.
export async function updateOrderStatus(orderId: number, input: UpdateOrderStatusInput) {
  const from = db.transaction((tx) => {
    const order = tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .get();
    if (!order) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    if (input.status === 'fulfilled') {
      const fulfilled = tx
        .update(orders)
        .set({ status: 'fulfilled', updatedAt: touchedNow })
        .where(and(eq(orders.id, orderId), eq(orders.status, 'paid')))
        .returning({ id: orders.id })
        .get();
      if (!fulfilled) {
        throw new ApiError(
          409,
          'INVALID_STATUS_TRANSITION',
          `Order is ${order.status}; only paid orders can be marked fulfilled`,
        );
      }
      return order.status;
    }

    if (order.status === 'paid' || order.status === 'fulfilled') {
      throw new ApiError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `Order is ${order.status}; refund its payment (POST /api/payments/:id/refund) instead`,
      );
    }
    cancelPendingOrder(tx, orderId);
    return order.status;
  });

  return {
    message: `Order ${orderId} marked ${input.status}`,
    changes: { status: { from, to: input.status } },
    order: await getOrder(orderId),
  };
}
