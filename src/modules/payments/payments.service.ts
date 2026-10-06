import { and, count, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { orderItems, orders, payments, productVariants } from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import * as gateway from './payments.gateway.js';
import type { ListPaymentsQuery } from './payments.types.js';

// Refunds are allowed for paid orders and for fulfilled ones (returns).
const REFUNDABLE_ORDER_STATUSES = ['paid', 'fulfilled'] as const;

const paymentColumns = getTableColumns(payments);

const touchedNow = sql`(current_timestamp)`;

function findPayment(userId: number, paymentId: number) {
  return db
    .select(paymentColumns)
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(payments.id, paymentId), eq(orders.userId, userId)))
    .get();
}

export async function listPayments(userId: number, query: ListPaymentsQuery) {
  const where = and(
    eq(orders.userId, userId),
    query.orderId ? eq(payments.orderId, query.orderId) : undefined,
    query.status ? eq(payments.status, query.status) : undefined,
  );

  const items = await db
    .select(paymentColumns)
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(where)
    // Tie-break on id so pages stay stable when timestamps repeat.
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(where);

  return {
    items,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

// Only payments for the caller's own orders are visible; anything else is a 404.
export async function getPayment(userId: number, paymentId: number) {
  const payment = findPayment(userId, paymentId);
  if (!payment) {
    throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
  }
  return payment;
}

// Admin-only full refund of a succeeded payment. The refund is a new
// `refunded` payment row (the original is never edited) and the order becomes
// `refunded`. The order is claimed before calling the gateway so two refunds
// can't both go through; if the gateway fails the claim is rolled back.
// Units of a `paid` order never shipped, so they go back into stock; returned
// goods from a `fulfilled` order are left to a separate restocking process.
export async function refundPayment(paymentId: number) {
  const claim = db.transaction((tx) => {
    const payment = tx.select().from(payments).where(eq(payments.id, paymentId)).get();
    if (!payment) {
      throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (payment.status !== 'succeeded') {
      throw new ApiError(
        409,
        'PAYMENT_NOT_REFUNDABLE',
        `Payment is ${payment.status}; only succeeded payments can be refunded`,
      );
    }

    const order = tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, payment.orderId))
      .get();
    const previousStatus = order?.status;
    if (
      !previousStatus ||
      !(REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(previousStatus)
    ) {
      throw new ApiError(
        409,
        'ORDER_NOT_REFUNDABLE',
        `Order is ${previousStatus} and cannot be refunded`,
      );
    }

    tx.update(orders)
      .set({ status: 'refunded', updatedAt: touchedNow })
      .where(eq(orders.id, payment.orderId))
      .run();

    return { payment, previousStatus };
  });

  const { payment, previousStatus } = claim;

  let providerRef: string;
  try {
    ({ providerRef } = await gateway.refund({
      provider: payment.provider,
      providerRef: payment.providerRef,
      amount: payment.amount,
    }));
  } catch (err) {
    db.update(orders)
      .set({ status: previousStatus })
      .where(and(eq(orders.id, payment.orderId), eq(orders.status, 'refunded')))
      .run();
    if (!(err instanceof gateway.PaymentGatewayError)) throw err;
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment provider could not be reached');
  }

  return db.transaction((tx) => {
    const refund = tx
      .insert(payments)
      .values({
        orderId: payment.orderId,
        provider: payment.provider,
        providerRef,
        status: 'refunded',
        amount: payment.amount,
      })
      .returning()
      .get();

    if (previousStatus === 'paid') {
      const lines = tx
        .select({ variantId: orderItems.variantId, quantity: orderItems.quantity })
        .from(orderItems)
        .where(eq(orderItems.orderId, payment.orderId))
        .all();
      for (const line of lines) {
        tx.update(productVariants)
          .set({ stockQuantity: sql`${productVariants.stockQuantity} + ${line.quantity}` })
          .where(eq(productVariants.id, line.variantId))
          .run();
      }
    }

    return refund;
  });
}
