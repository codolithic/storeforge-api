import { and, asc, count, desc, eq, gt, inArray, sql, sum } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  addresses,
  cartItems,
  carts,
  inventoryReservations,
  orderItems,
  orders,
  products,
  productVariants,
} from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import {
  RESERVATION_TTL_MINUTES,
  type CheckoutInput,
  type ListOrdersQuery,
} from './orders.types.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is stored as SQLite `real`, so round derived totals to cents.
const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

const ownedOrder = (userId: number, orderId: number) =>
  and(eq(orders.id, orderId), eq(orders.userId, userId));

const orderWith = {
  shippingAddress: {
    columns: {
      id: true,
      line1: true,
      line2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    },
  },
  items: {
    columns: {
      id: true,
      variantId: true,
      productName: true,
      variantAttributes: true,
      unitPrice: true,
      quantity: true,
    },
    orderBy: asc(orderItems.id),
  },
} as const;

type OrderRow = NonNullable<Awaited<ReturnType<typeof findOrder>>>;

function findOrder(userId: number, orderId: number) {
  return db.query.orders.findFirst({
    columns: { userId: false },
    where: ownedOrder(userId, orderId),
    with: orderWith,
  });
}

function formatOrder({ items, ...order }: OrderRow) {
  const lines = items.map((item) => ({
    ...item,
    lineTotal: roundMoney(item.unitPrice * item.quantity),
  }));
  return {
    ...order,
    items: lines,
    itemCount: lines.reduce((total, item) => total + item.quantity, 0),
  };
}

// An explicit address must be the caller's own; otherwise fall back to their
// default address, if any. Foreign ids are a 404 so they aren't revealed.
function resolveShippingAddressId(tx: Tx, userId: number, addressId: number | undefined) {
  if (addressId === undefined) {
    return (
      tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)))
        .orderBy(asc(addresses.id))
        .get()?.id ?? null
    );
  }

  const address = tx
    .select({ id: addresses.id })
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.userId, userId)))
    .get();
  if (!address) {
    throw new ApiError(404, 'ADDRESS_NOT_FOUND', 'Shipping address not found');
  }
  return address.id;
}

// Stock still held by other pending checkouts whose reservations haven't lapsed.
function reservedQuantities(tx: Tx, variantIds: number[], now: string) {
  const rows = tx
    .select({
      variantId: inventoryReservations.variantId,
      reserved: sum(inventoryReservations.quantity),
    })
    .from(inventoryReservations)
    .where(
      and(
        inArray(inventoryReservations.variantId, variantIds),
        gt(inventoryReservations.expiresAt, now),
      ),
    )
    .groupBy(inventoryReservations.variantId)
    .all();
  return new Map(rows.map((row) => [row.variantId, Number(row.reserved ?? 0)]));
}

export async function listOrders(userId: number, query: ListOrdersQuery) {
  const where = and(
    eq(orders.userId, userId),
    query.status ? eq(orders.status, query.status) : undefined,
  );

  const rows = await db.query.orders.findMany({
    columns: { userId: false },
    where,
    with: orderWith,
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

// Only the caller's own orders are visible; anything else is a 404.
export async function getOrder(userId: number, orderId: number) {
  const order = await findOrder(userId, orderId);
  if (!order) {
    throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  return formatOrder(order);
}

// Turns the caller's active cart into a pending order. Prices, names and
// attributes are snapshotted from the current variant/product, and stock is
// held with inventory reservations rather than decrementing stockQuantity.
// Runs as one synchronous better-sqlite3 transaction, so two concurrent
// checkouts can't both claim the same stock or convert the same cart.
export async function checkout(userId: number, input: CheckoutInput) {
  const orderId = db.transaction((tx) => {
    const cart = tx
      .select({ id: carts.id })
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, 'active')))
      .orderBy(desc(carts.id))
      .get();

    const lines = cart
      ? tx
          .select({
            variantId: productVariants.id,
            quantity: cartItems.quantity,
            price: productVariants.price,
            attributes: productVariants.attributes,
            stockQuantity: productVariants.stockQuantity,
            productName: products.name,
            productStatus: products.status,
          })
          .from(cartItems)
          .innerJoin(productVariants, eq(productVariants.id, cartItems.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .where(eq(cartItems.cartId, cart.id))
          .orderBy(asc(cartItems.id))
          .all()
      : [];

    if (!cart || lines.length === 0) {
      throw new ApiError(400, 'CART_EMPTY', 'Cannot check out an empty cart');
    }

    const shippingAddressId = resolveShippingAddressId(tx, userId, input.shippingAddressId);

    const now = new Date();
    const reserved = reservedQuantities(
      tx,
      lines.map((line) => line.variantId),
      now.toISOString(),
    );

    for (const line of lines) {
      if (line.productStatus !== 'active') {
        throw new ApiError(409, 'ITEM_UNAVAILABLE', `${line.productName} is no longer available`);
      }
      const available = line.stockQuantity - (reserved.get(line.variantId) ?? 0);
      if (line.quantity > available) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${line.productName}`);
      }
    }

    const subtotal = roundMoney(
      lines.reduce((total, line) => total + line.price * line.quantity, 0),
    );
    // Tax and shipping aren't modelled yet, so both stay at their 0 default.
    const order = tx
      .insert(orders)
      .values({ userId, subtotal, total: subtotal, shippingAddressId })
      .returning({ id: orders.id })
      .get();

    tx.insert(orderItems)
      .values(
        lines.map((line) => ({
          orderId: order.id,
          variantId: line.variantId,
          productName: line.productName,
          variantAttributes: line.attributes,
          unitPrice: line.price,
          quantity: line.quantity,
        })),
      )
      .run();

    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MINUTES * 60_000).toISOString();
    tx.insert(inventoryReservations)
      .values(
        lines.map((line) => ({
          orderId: order.id,
          variantId: line.variantId,
          quantity: line.quantity,
          expiresAt,
        })),
      )
      .run();

    tx.update(carts).set({ status: 'converted' }).where(eq(carts.id, cart.id)).run();

    return order.id;
  });

  return getOrder(userId, orderId);
}

// Only pending (unpaid) orders can be cancelled by the customer. The status
// change is a single conditional UPDATE so it can't race with another
// transition, and the order's stock holds are released with it.
export async function cancelOrder(userId: number, orderId: number) {
  db.transaction((tx) => {
    const cancelled = tx
      .update(orders)
      .set({ status: 'cancelled', updatedAt: sql`(current_timestamp)` })
      .where(and(ownedOrder(userId, orderId), eq(orders.status, 'pending')))
      .returning({ id: orders.id })
      .get();

    if (!cancelled) {
      const existing = tx
        .select({ status: orders.status })
        .from(orders)
        .where(ownedOrder(userId, orderId))
        .get();
      if (!existing) {
        throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
      }
      throw new ApiError(
        409,
        'ORDER_NOT_CANCELLABLE',
        `Order is ${existing.status} and can no longer be cancelled`,
      );
    }

    tx.delete(inventoryReservations).where(eq(inventoryReservations.orderId, orderId)).run();
  });

  return getOrder(userId, orderId);
}
