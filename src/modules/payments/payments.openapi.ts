import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  bearerAuth,
  errors,
  json,
  paginated,
  timestamp,
  type Assert,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as paymentsService from './payments.service.js';
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  paymentParamsSchema,
} from './payments.types.js';

const paymentSchema = z
  .object({
    id: z.number().int(),
    orderId: z.number().int(),
    provider: z.string(),
    providerRef: z.string().nullable().meta({ description: 'Gateway transaction id' }),
    status: z.enum(['pending', 'succeeded', 'failed', 'refunded']),
    amount: z.number(),
    createdAt: timestamp,
  })
  .meta({ id: 'Payment' });

const paymentListSchema = paginated(paymentSchema);

type _payment = Assert<
  Documents<typeof paymentSchema, ReturnOf<typeof paymentsService.getPayment>>
>;
type _refund = Assert<
  Documents<typeof paymentSchema, ReturnOf<typeof paymentsService.refundPayment>>
>;
type _list = Assert<
  Documents<typeof paymentListSchema, ReturnOf<typeof paymentsService.listPayments>>
>;

export const paymentPaths: ZodOpenApiPathsObject = {
  '/api/payments': {
    post: {
      tags: ['Payments'],
      operationId: 'createPayment',
      summary: 'Pay for a pending order',
      description:
        'Charges `order.total` through the simulated gateway: `paymentToken` `tok_declined` is declined, `tok_gateway_error` simulates a provider failure, anything else succeeds. Success marks the order `paid`. If the stock hold has lapsed, the order is cancelled (409 `CHECKOUT_EXPIRED`).',
      security: bearerAuth,
      requestBody: { content: { 'application/json': { schema: createPaymentSchema } } },
      responses: {
        201: json('The succeeded payment', paymentSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          402: ['PAYMENT_DECLINED'],
          404: ['ORDER_NOT_FOUND'],
          409: ['ORDER_NOT_PAYABLE', 'PAYMENT_IN_PROGRESS', 'CHECKOUT_EXPIRED'],
          502: ['PAYMENT_GATEWAY_ERROR'],
        }),
      },
    },
    get: {
      tags: ['Payments'],
      operationId: 'listPayments',
      summary: 'List payments for the caller’s orders',
      description: 'Newest first.',
      security: bearerAuth,
      requestParams: { query: listPaymentsQuerySchema },
      responses: {
        200: json('A page of payments', paymentListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 401: ['UNAUTHORIZED'] }),
      },
    },
  },
  '/api/payments/{id}': {
    get: {
      tags: ['Payments'],
      operationId: 'getPayment',
      summary: 'Get a payment for one of the caller’s orders',
      security: bearerAuth,
      requestParams: { path: paymentParamsSchema },
      responses: {
        200: json('The payment', paymentSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          404: ['PAYMENT_NOT_FOUND'],
        }),
      },
    },
  },
  '/api/payments/{id}/refund': {
    post: {
      tags: ['Payments'],
      operationId: 'refundPayment',
      summary: 'Refund a succeeded payment (admin)',
      description:
        'Admin only. Full refund recorded as a new `refunded` payment; the order becomes `refunded`. Stock is restored only if the order was `paid`, not `fulfilled`.',
      security: bearerAuth,
      requestParams: { path: paymentParamsSchema },
      responses: {
        201: json('The refund payment', paymentSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          403: ['FORBIDDEN'],
          404: ['PAYMENT_NOT_FOUND'],
          409: ['PAYMENT_NOT_REFUNDABLE', 'ORDER_NOT_REFUNDABLE'],
          502: ['PAYMENT_GATEWAY_ERROR'],
        }),
      },
    },
  },
};
