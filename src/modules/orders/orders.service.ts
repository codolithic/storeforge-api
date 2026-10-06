import { and, asc, count, desc, eq, gt, inArray, notExists, sql, sum } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  addresses,
  cartItems,
  carts,
  inventoryReservations,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
} from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import * as gateway from '../payments/payments.gateway.js';
import {
  RESERVATION_TTL_MINUTES,
  type CheckoutInput,
  type ListOrdersQuery,
} from './orders.types.js';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is stored as SQLite `real`, so round derived totals to cents.
const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

const ownedOrder = (userId: number, orderId: number) =>
  and(eq(orders.id, orderId), eq(orders.userId, userId));

// Shared with the admin order routes, which list every user's orders.
export const orderWith = {
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

type OrderItemRow = NonNullable<Awaited<ReturnType<typeof findOrder>>>['items'][number];

function findOrder(userId: number, orderId: number) {
  return db.query.orders.findFirst({
    columns: { userId: false },
    where: ownedOrder(userId, orderId),
    with: orderWith,
  });
}

export function formatOrder<T extends { items: OrderItemRow[] }>({ items, ...order }: T) {
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
        eq(inventoryReservations.status, 'active'),
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

// Turns the caller's active cart into an order and pays for it in one call.
// Prices, names and attributes are snapshotted from the current variant/product.
// It runs in two phases around the (async) gateway call:
//   1. one synchronous better-sqlite3 transaction validates stock and creates
//      the `pending` order, its items, `active` reservations and a `pending`
//      payment for order.total, and marks the cart `converted`. Two concurrent
//      checkouts can't both claim the same stock or convert the same cart.
//   2. after the gateway answers, a second transaction settles everything:
//      success -> payment `succeeded`, order `paid`, reservations `fulfilled`
//                 and the held units leave stockQuantity;
//      failure -> payment `failed`, order `cancelled`, reservations `expired`,
//                 and the cart is reopened so the customer can try again.
export async function checkout(userId: number, input: CheckoutInput) {
  const placed = db.transaction((tx) => {
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
      .returning({ id: orders.id, total: orders.total })
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

    const payment = tx
      .insert(payments)
      .values({ orderId: order.id, provider: input.provider, amount: order.total })
      .returning({ id: payments.id })
      .get();

    return { orderId: order.id, cartId: cart.id, paymentId: payment.id, amount: order.total };
  });

  let result: gateway.ChargeResult;
  try {
    result = await gateway.charge({
      provider: input.provider,
      amount: placed.amount,
      paymentToken: input.paymentToken,
    });
  } catch (err) {
    if (!(err instanceof gateway.PaymentGatewayError)) throw err;
    // The provider never confirmed a charge, so treat it as a failed payment.
    db.transaction((tx) => failCheckout(tx, userId, placed, null));
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment provider could not be reached');
  }

  if (result.status === 'failed') {
    db.transaction((tx) => failCheckout(tx, userId, placed, result.providerRef));
    throw new ApiError(402, 'PAYMENT_DECLINED', result.declineReason);
  }

  db.transaction((tx) => {
    // Conditional on `pending`: if the order was cancelled while the gateway
    // call was in flight, the payment is already `failed` and nothing else moves.
    const settled = tx
      .update(payments)
      .set({ status: 'succeeded', providerRef: result.providerRef })
      .where(and(eq(payments.id, placed.paymentId), eq(payments.status, 'pending')))
      .returning({ id: payments.id })
      .get();
    if (!settled) {
      throw new ApiError(
        409,
        'ORDER_NOT_PAYABLE',
        'The order was cancelled while its payment was being processed',
      );
    }

    tx.update(orders)
      .set({ status: 'paid', updatedAt: sql`(current_timestamp)` })
      .where(eq(orders.id, placed.orderId))
      .run();

    // Holds that lapsed during the gateway call are still honoured, since the
    // money has already been taken.
    const fulfilled = tx
      .update(inventoryReservations)
      .set({ status: 'fulfilled' })
      .where(
        and(
          eq(inventoryReservations.orderId, placed.orderId),
          eq(inventoryReservations.status, 'active'),
        ),
      )
      .returning({
        variantId: inventoryReservations.variantId,
        quantity: inventoryReservations.quantity,
      })
      .all();

    for (const hold of fulfilled) {
      tx.update(productVariants)
        .set({ stockQuantity: sql`${productVariants.stockQuantity} - ${hold.quantity}` })
        .where(eq(productVariants.id, hold.variantId))
        .run();
    }
  });

  return getOrder(userId, placed.orderId);
}

// Settles a checkout whose charge didn't go through: the payment is `failed`,
// the order `cancelled` and its holds `expired`. The converted cart is reopened
// (unless the customer has started a new one) so they can retry checkout.
function failCheckout(
  tx: Tx,
  userId: number,
  placed: { orderId: number; cartId: number; paymentId: number },
  providerRef: string | null,
) {
  tx.update(payments)
    .set({ status: 'failed', providerRef })
    .where(and(eq(payments.id, placed.paymentId), eq(payments.status, 'pending')))
    .run();
  tx.update(orders)
    .set({ status: 'cancelled', updatedAt: sql`(current_timestamp)` })
    .where(and(eq(orders.id, placed.orderId), eq(orders.status, 'pending')))
    .run();
  expireHolds(tx, placed.orderId);
  tx.update(carts)
    .set({ status: 'active' })
    .where(
      and(
        eq(carts.id, placed.cartId),
        eq(carts.status, 'converted'),
        notExists(
          tx
            .select({ id: carts.id })
            .from(carts)
            .where(and(eq(carts.userId, userId), eq(carts.status, 'active'))),
        ),
      ),
    )
    .run();
}

function expireHolds(tx: Tx, orderId: number) {
  tx.update(inventoryReservations)
    .set({ status: 'expired' })
    .where(
      and(eq(inventoryReservations.orderId, orderId), eq(inventoryReservations.status, 'active')),
    )
    .run();
}

// Only pending (unpaid) orders can be cancelled. The status change is a single
// conditional UPDATE so it can't race with another transition. Any payment
// still `pending` for the order is marked `failed` and its stock holds expire.
// `userId` scopes the order to its owner; admins pass undefined for any order.
export function cancelPendingOrder(tx: Tx, orderId: number, userId?: number) {
  const scope = userId === undefined ? eq(orders.id, orderId) : ownedOrder(userId, orderId);

  const cancelled = tx
    .update(orders)
    .set({ status: 'cancelled', updatedAt: sql`(current_timestamp)` })
    .where(and(scope, eq(orders.status, 'pending')))
    .returning({ id: orders.id })
    .get();

  if (!cancelled) {
    const existing = tx.select({ status: orders.status }).from(orders).where(scope).get();
    if (!existing) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    throw new ApiError(
      409,
      'ORDER_NOT_CANCELLABLE',
      `Order is ${existing.status} and can no longer be cancelled`,
    );
  }

  tx.update(payments)
    .set({ status: 'failed' })
    .where(and(eq(payments.orderId, orderId), eq(payments.status, 'pending')))
    .run();
  expireHolds(tx, orderId);
}

export async function cancelOrder(userId: number, orderId: number) {
  db.transaction((tx) => cancelPendingOrder(tx, orderId, userId));
  return getOrder(userId, orderId);
}
