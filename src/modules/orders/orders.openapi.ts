import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  attributes,
  bearerAuth,
  errors,
  json,
  paginated,
  timestamp,
  type Assert,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as ordersService from './orders.service.js';
import { checkoutSchema, listOrdersQuerySchema, orderParamsSchema } from './orders.types.js';

export const orderSchema = z
  .object({
    id: z.number().int(),
    status: z.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']),
    subtotal: z.number(),
    tax: z.number(),
    shippingFee: z.number(),
    total: z.number(),
    shippingAddressId: z.number().int().nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    shippingAddress: z
      .object({
        id: z.number().int(),
        line1: z.string(),
        line2: z.string().nullable(),
        city: z.string(),
        state: z.string(),
        postalCode: z.string(),
        country: z.string(),
      })
      .nullable(),
    items: z.array(
      z.object({
        id: z.number().int(),
        variantId: z.number().int(),
        productName: z.string().meta({ description: 'Snapshot at purchase time' }),
        variantAttributes: attributes,
        unitPrice: z.number().meta({ description: 'Snapshot at purchase time' }),
        quantity: z.number().int(),
        lineTotal: z.number(),
      }),
    ),
    itemCount: z.number().int(),
  })
  .meta({ id: 'Order' });

const orderListSchema = paginated(orderSchema);

type _order = Assert<Documents<typeof orderSchema, ReturnOf<typeof ordersService.getOrder>>>;
type _list = Assert<Documents<typeof orderListSchema, ReturnOf<typeof ordersService.listOrders>>>;

const notFound = errors({
  400: ['VALIDATION_ERROR'],
  401: ['UNAUTHORIZED'],
  404: ['ORDER_NOT_FOUND'],
});

export const orderPaths: ZodOpenApiPathsObject = {
  '/api/orders': {
    post: {
      tags: ['Orders'],
      operationId: 'checkout',
      summary: 'Check out and pay for the active cart',
      description:
        'Creates an order from the cart (snapshotting current prices and names, holding stock, and recording a `pending` payment for the total), then charges it through the simulated gateway: `paymentToken` `tok_decline` is declined, `tok_gateway_error` simulates a provider failure, anything else (or none) succeeds. Success returns the `paid` order. A failed charge cancels the order, marks the payment `failed`, releases the stock, and reopens the cart. Ships to `shippingAddressId` if given, else the default address. The body is optional; `provider` defaults to `stripe`.',
      security: bearerAuth,
      requestBody: {
        required: false,
        content: { 'application/json': { schema: checkoutSchema } },
      },
      responses: {
        201: json('The paid order', orderSchema),
        ...errors({
          400: ['VALIDATION_ERROR', 'CART_EMPTY'],
          401: ['UNAUTHORIZED'],
          402: ['PAYMENT_DECLINED'],
          404: ['ADDRESS_NOT_FOUND'],
          409: ['ITEM_UNAVAILABLE', 'INSUFFICIENT_STOCK', 'ORDER_NOT_PAYABLE'],
          502: ['PAYMENT_GATEWAY_ERROR'],
        }),
      },
    },
    get: {
      tags: ['Orders'],
      operationId: 'listOrders',
      summary: 'List the caller’s orders',
      description: 'Newest first.',
      security: bearerAuth,
      requestParams: { query: listOrdersQuerySchema },
      responses: {
        200: json('A page of orders', orderListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 401: ['UNAUTHORIZED'] }),
      },
    },
  },
  '/api/orders/{id}': {
    get: {
      tags: ['Orders'],
      operationId: 'getOrder',
      summary: 'Get one of the caller’s orders',
      description: 'Other users’ orders are 404.',
      security: bearerAuth,
      requestParams: { path: orderParamsSchema },
      responses: { 200: json('The order', orderSchema), ...notFound },
    },
  },
  '/api/orders/{id}/cancel': {
    post: {
      tags: ['Orders'],
      operationId: 'cancelOrder',
      summary: 'Cancel a pending order',
      description:
        'Only `pending` orders. Any `pending` payment for the order is marked `failed`, and its stock holds expire.',
      security: bearerAuth,
      requestParams: { path: orderParamsSchema },
      responses: {
        200: json('The cancelled order', orderSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          404: ['ORDER_NOT_FOUND'],
          409: ['ORDER_NOT_CANCELLABLE'],
        }),
      },
    },
  },
};
