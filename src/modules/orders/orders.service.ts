import { and, asc, count, desc, eq, notExists, sql } from 'drizzle-orm';
import { db } from '@db/index.js';
import {
  cartItems,
  carts,
  inventoryReservations,
  orderItems,
  orders,
  payments,
  products,
  productVariants,
} from '@db/schema.js';
import { ApiError } from '@middlewares/error.middleware.js';
import * as gateway from '../payments/payments.gateway.js';
import {
  findOrder,
  formatOrder,
  orderWith,
  ownedOrder,
  reservedQuantities,
  resolveShippingAddressId,
  roundMoney,
  expireHolds,
  failCheckout,
} from './orders.utils.js';
import {
  RESERVATION_TTL_MINUTES,
  type CheckoutInput,
  type ListOrdersQuery,
} from './orders.types.js';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
    // first find the cart of the user
    const cart = tx
      .select({ id: carts.id })
      .from(carts)
      .where(and(eq(carts.userId, userId), eq(carts.status, 'active')))
      .orderBy(desc(carts.id))
      .get();

    // if cart exist then get all the cart items with product and variant data
    /**
     * select pv.id as "variantId", ci.quantity as quantity, pv.price as price, pv.attributes as attributes,
     * pv.stock_quantity as "stockQuantity", p.name as "productName", p.status as "productStatus"
     * from cart_items as ci inner join product_variants as pv
     * on pv.id = ci.variant_id inner join products as p on p.id = pv.product_id
     * where ci.cart_id = <<cart.id>> order by ci.id
     */
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

    // this will just get the default address for user if input.shippingAddressId is not provided
    // else just check if the address exist and belongs to the user
    const shippingAddressId = resolveShippingAddressId(tx, userId, input.shippingAddressId);

    const now = new Date();
    // get any active reserved quantities that already exist
    // returned value type - {[variantId]: quantity}
    const reserved = reservedQuantities(
      tx,
      lines.map((line) => line.variantId),
      now.toISOString(),
    );

    for (const line of lines) {
      if (line.productStatus !== 'active') {
        throw new ApiError(409, 'ITEM_UNAVAILABLE', `${line.productName} is no longer available`);
      }

      // this is where we deduct the available stock
      // line.stockQuantity is the productVariant.stockQuantity
      // reserved is the existing inventory reservations which
      // will be null or undefined if does not exist
      const available = line.stockQuantity - (reserved.get(line.variantId) ?? 0);
      if (line.quantity > available) {
        throw new ApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock for ${line.productName}`);
      }
    }

    // for better understanding
    // arr.reduce((accumulator, currentValue) => { returns updated accumulator }, "")
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
