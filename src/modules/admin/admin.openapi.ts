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
import { orderSchema } from '../orders/orders.openapi.js';
import type * as adminService from './admin.service.js';
import {
  adminIdParamsSchema,
  createProductSchema,
  listAdminOrdersQuerySchema,
  updateOrderStatusSchema,
  updateProductSchema,
} from './admin.types.js';

const adminProductSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    basePrice: z.number(),
    status: z.enum(['active', 'draft', 'archived']),
    createdAt: timestamp,
    updatedAt: timestamp,
    category: z.object({ id: z.number().int(), name: z.string(), slug: z.string() }).nullable(),
    images: z.array(
      z.object({ id: z.number().int(), url: z.string(), position: z.number().int() }),
    ),
    variants: z.array(
      z.object({
        id: z.number().int(),
        sku: z.string(),
        price: z.number(),
        attributes,
        stockQuantity: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'AdminProduct' });

const createdProductSchema = z.object({ message: z.string(), product: adminProductSchema });

const updatedProductSchema = z.object({
  message: z.string(),
  changes: z
    .object({
      name: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      basePrice: z.number(),
      categoryId: z.number().int().nullable(),
      status: z.enum(['active', 'draft', 'archived']),
    })
    .partial()
    .meta({ description: 'The fields that were applied' }),
  product: adminProductSchema,
});

const adminOrderSchema = orderSchema
  .extend({ userId: z.number().int() })
  .meta({ id: 'AdminOrder' });
const adminOrderListSchema = paginated(adminOrderSchema);

const orderStatusChangeSchema = z.object({
  message: z.string(),
  changes: z.object({
    status: z.object({
      from: z.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']),
      to: z.enum(['fulfilled', 'cancelled']),
    }),
  }),
  order: adminOrderSchema,
});

type _create = Assert<
  Documents<typeof createdProductSchema, ReturnOf<typeof adminService.createProduct>>
>;
type _update = Assert<
  Documents<typeof updatedProductSchema, ReturnOf<typeof adminService.updateProduct>>
>;
type _orders = Assert<
  Documents<typeof adminOrderListSchema, ReturnOf<typeof adminService.listOrders>>
>;
type _status = Assert<
  Documents<typeof orderStatusChangeSchema, ReturnOf<typeof adminService.updateOrderStatus>>
>;

const ADMIN_ONLY = 'Admin only.';

export const adminPaths: ZodOpenApiPathsObject = {
  '/api/admin/products': {
    post: {
      tags: ['Admin'],
      operationId: 'adminCreateProduct',
      summary: 'Create a product with its variants and images',
      description: `${ADMIN_ONLY} Variants carry the real price and stock; a product needs at least one to be purchasable. \`status\` defaults to \`draft\`. Slugs are lowercased.`,
      security: bearerAuth,
      requestBody: { content: { 'application/json': { schema: createProductSchema } } },
      responses: {
        201: json('The created product', createdProductSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          403: ['FORBIDDEN'],
          404: ['CATEGORY_NOT_FOUND'],
          409: ['SLUG_IN_USE', 'SKU_IN_USE'],
        }),
      },
    },
  },
  '/api/admin/products/{id}': {
    patch: {
      tags: ['Admin'],
      operationId: 'adminUpdateProduct',
      summary: 'Update a product’s fields',
      description: `${ADMIN_ONLY} Product-level fields only (not variants or images); send at least one. Any status can be edited.`,
      security: bearerAuth,
      requestParams: { path: adminIdParamsSchema },
      requestBody: { content: { 'application/json': { schema: updateProductSchema } } },
      responses: {
        200: json('The updated product', updatedProductSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          403: ['FORBIDDEN'],
          404: ['PRODUCT_NOT_FOUND', 'CATEGORY_NOT_FOUND'],
          409: ['SLUG_IN_USE'],
        }),
      },
    },
  },
  '/api/admin/orders': {
    get: {
      tags: ['Admin'],
      operationId: 'adminListOrders',
      summary: 'List all orders',
      description: `${ADMIN_ONLY} Every user’s orders, newest first, filterable by \`status\` and \`userId\`.`,
      security: bearerAuth,
      requestParams: { query: listAdminOrdersQuerySchema },
      responses: {
        200: json('A page of orders', adminOrderListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 401: ['UNAUTHORIZED'], 403: ['FORBIDDEN'] }),
      },
    },
  },
  '/api/admin/orders/{id}/status': {
    patch: {
      tags: ['Admin'],
      operationId: 'adminUpdateOrderStatus',
      summary: 'Mark an order fulfilled or cancel an unpaid one',
      description: `${ADMIN_ONLY} \`fulfilled\`: paid orders only (shipped/delivered). \`cancelled\`: pending orders only; a pending payment is marked \`failed\` and the stock holds expire. Paid orders are cancelled by refunding their payment (\`POST /api/payments/{id}/refund\`).`,
      security: bearerAuth,
      requestParams: { path: adminIdParamsSchema },
      requestBody: { content: { 'application/json': { schema: updateOrderStatusSchema } } },
      responses: {
        200: json('The status change and the updated order', orderStatusChangeSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          403: ['FORBIDDEN'],
          404: ['ORDER_NOT_FOUND'],
          409: ['INVALID_STATUS_TRANSITION', 'ORDER_NOT_CANCELLABLE'],
        }),
      },
    },
  },
};
