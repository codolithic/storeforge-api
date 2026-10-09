import { and, asc, count, desc, eq, notExists, sql, sum, inArray, gt } from 'drizzle-orm';
import { db } from '#db/index.js';
import {
  addresses,
  carts,
  inventoryReservations,
  orderItems,
  orders,
  payments,
} from '#db/schema.js';
import { ApiError } from '#middlewares/error.middleware.js';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is stored as SQLite `real`, so round derived totals to cents.
export const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

export const ownedOrder = (userId: number, orderId: number) =>
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

export function findOrder(userId: number, orderId: number) {
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
export function resolveShippingAddressId(tx: Tx, userId: number, addressId: number | undefined) {
  if (addressId === undefined) {
    // Since the caller did not provide provide, lets use the default address of the current user
    return (
      tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.userId, userId), eq(addresses.isDefault, true)))
        .orderBy(asc(addresses.id))
        .get()?.id ?? null
    );
  }

  // The caller has provided the address. Lets use it to find if it belongs to the current user.
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
export function reservedQuantities(tx: Tx, variantIds: number[], now: string) {
  /**
   * select ir.variant_id, sum(ir.quantity) from inventory_reservations as ir
   * where ir.variant_id in (...variantIds) and ir.status = 'active' and
   * ir.expires_at > 'now' group by ir.variant_id
   */
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

  // {[variantId]: quantity}
  return new Map(rows.map((row) => [row.variantId, Number(row.reserved ?? 0)]));
}

// Settles a checkout whose charge didn't go through: the payment is `failed`,
// the order `cancelled` and its holds `expired`. The converted cart is reopened
// (unless the customer has started a new one) so they can retry checkout.
export function failCheckout(
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

export function expireHolds(tx: Tx, orderId: number) {
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
