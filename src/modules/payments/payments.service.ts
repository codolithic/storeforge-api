import { and, count, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  inventoryReservations,
  orderItems,
  orders,
  payments,
  productVariants,
} from '../../db/schema.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import * as gateway from './payments.gateway.js';
import type { CreatePaymentInput, ListPaymentsQuery } from './payments.types.js';

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

// Pays for a pending order in two phases around the (async) gateway call:
//   1. a transaction validates the order and records a `pending` payment for
//      order.total. That row acts as a lock: while it exists, further payment
//      attempts and customer cancellation of the order are rejected.
//   2. after the gateway answers, a second transaction resolves the payment to
//      `succeeded`/`failed`. On success the order becomes `paid`, its active
//      reservations become `fulfilled`, and the held units leave stockQuantity.
// A declined charge leaves the order pending with its holds, so it can be retried.
export async function createPayment(userId: number, input: CreatePaymentInput) {
  const claim = db.transaction((tx) => {
    const order = tx
      .select({ id: orders.id, status: orders.status, total: orders.total })
      .from(orders)
      .where(and(eq(orders.id, input.orderId), eq(orders.userId, userId)))
      .get();
    if (!order) {
      throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    if (order.status !== 'pending') {
      throw new ApiError(409, 'ORDER_NOT_PAYABLE', `Order is ${order.status} and cannot be paid`);
    }

    const inFlight = tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.orderId, order.id), eq(payments.status, 'pending')))
      .get();
    if (inFlight) {
      throw new ApiError(
        409,
        'PAYMENT_IN_PROGRESS',
        'A payment for this order is already in progress',
      );
    }

    // The checkout timed out if any stock hold has lapsed: the stock is no
    // longer guaranteed, so the holds are expired and the order is cancelled.
    const now = new Date().toISOString();
    const holds = tx
      .select({ expiresAt: inventoryReservations.expiresAt })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.orderId, order.id),
          eq(inventoryReservations.status, 'active'),
        ),
      )
      .all();
    if (holds.length === 0 || holds.some((hold) => hold.expiresAt <= now)) {
      tx.update(inventoryReservations)
        .set({ status: 'expired' })
        .where(
          and(
            eq(inventoryReservations.orderId, order.id),
            eq(inventoryReservations.status, 'active'),
          ),
        )
        .run();
      tx.update(orders)
        .set({ status: 'cancelled', updatedAt: touchedNow })
        .where(eq(orders.id, order.id))
        .run();
      return { expired: true } as const;
    }

    const payment = tx
      .insert(payments)
      .values({ orderId: order.id, provider: input.provider, amount: order.total })
      .returning({ id: payments.id, amount: payments.amount })
      .get();
    return { expired: false, payment } as const;
  });

  // Thrown outside the transaction so the expiry/cancellation above is kept.
  if (claim.expired) {
    throw new ApiError(
      409,
      'CHECKOUT_EXPIRED',
      'The stock hold for this order has expired, so the order was cancelled',
    );
  }

  const paymentId = claim.payment.id;

  let result: gateway.ChargeResult;
  try {
    result = await gateway.charge({
      provider: input.provider,
      amount: claim.payment.amount,
      paymentToken: input.paymentToken,
    });
  } catch (err) {
    if (!(err instanceof gateway.PaymentGatewayError)) throw err;
    // The provider never confirmed a charge, so release the lock as failed.
    db.update(payments)
      .set({ status: 'failed' })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
      .run();
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment provider could not be reached');
  }

  db.transaction((tx) => {
    tx.update(payments)
      .set({ status: result.status, providerRef: result.providerRef })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'pending')))
      .run();

    if (result.status !== 'succeeded') return;

    // The order is still pending: cancellation and other payments are blocked
    // while this payment was pending. Holds that lapsed during the gateway call
    // are still honoured, since the money has already been taken.
    tx.update(orders)
      .set({ status: 'paid', updatedAt: touchedNow })
      .where(eq(orders.id, input.orderId))
      .run();

    const fulfilled = tx
      .update(inventoryReservations)
      .set({ status: 'fulfilled' })
      .where(
        and(
          eq(inventoryReservations.orderId, input.orderId),
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

  if (result.status === 'failed') {
    throw new ApiError(402, 'PAYMENT_DECLINED', result.declineReason);
  }

  return getPayment(userId, paymentId);
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
