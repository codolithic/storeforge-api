import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  attributes,
  bearerAuth,
  errors,
  json,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as cartService from './cart.service.js';
import { addCartItemSchema, cartItemParamsSchema, updateCartItemSchema } from './cart.types.js';

const cartSchema = z
  .object({
    id: z.number().int().nullable().meta({ description: 'null until the first item is added' }),
    items: z.array(
      z.object({
        id: z.number().int(),
        variantId: z.number().int(),
        sku: z.string(),
        attributes,
        product: z.object({ id: z.number().int(), name: z.string(), slug: z.string() }),
        quantity: z.number().int(),
        unitPriceSnapshot: z
          .number()
          .meta({ description: 'Variant price when the line was added' }),
        lineTotal: z.number(),
        available: z
          .boolean()
          .meta({ description: 'false if the product is no longer active or stock is short' }),
      }),
    ),
    itemCount: z.number().int(),
    subtotal: z.number(),
  })
  .meta({ id: 'Cart' });

// getCart returns a union (an empty `id: null` cart or a real one), which the
// single documented shape can't equal, so only check one way: every value the
// service returns must fit the schema (the constraint on Documents' 2nd param).
type _cart = Documents<typeof cartSchema, ReturnOf<typeof cartService.getCart>>;

const auth = errors({ 401: ['UNAUTHORIZED'] });

export const cartPaths: ZodOpenApiPathsObject = {
  '/api/cart': {
    get: {
      tags: ['Cart'],
      operationId: 'getCart',
      summary: 'Get the caller’s active cart',
      security: bearerAuth,
      responses: { 200: json('The cart', cartSchema), ...auth },
    },
  },
  '/api/cart/items': {
    post: {
      tags: ['Cart'],
      operationId: 'addCartItem',
      summary: 'Add a variant to the cart',
      description:
        'Adding a variant already in the cart merges into its line and refreshes the price snapshot. Each line is capped at 99 units and by stock.',
      security: bearerAuth,
      requestBody: { content: { 'application/json': { schema: addCartItemSchema } } },
      responses: {
        200: json('Merged into an existing line', cartSchema),
        201: json('New line added', cartSchema),
        ...errors({
          400: ['VALIDATION_ERROR', 'QUANTITY_LIMIT_EXCEEDED'],
          401: ['UNAUTHORIZED'],
          404: ['VARIANT_NOT_FOUND'],
          409: ['INSUFFICIENT_STOCK'],
        }),
      },
    },
  },
  '/api/cart/items/{id}': {
    patch: {
      tags: ['Cart'],
      operationId: 'updateCartItem',
      summary: 'Change a line’s quantity',
      description: 'Keeps the original price snapshot.',
      security: bearerAuth,
      requestParams: { path: cartItemParamsSchema },
      requestBody: { content: { 'application/json': { schema: updateCartItemSchema } } },
      responses: {
        200: json('The updated cart', cartSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          404: ['CART_ITEM_NOT_FOUND', 'VARIANT_NOT_FOUND'],
          409: ['INSUFFICIENT_STOCK'],
        }),
      },
    },
    delete: {
      tags: ['Cart'],
      operationId: 'removeCartItem',
      summary: 'Remove a line',
      security: bearerAuth,
      requestParams: { path: cartItemParamsSchema },
      responses: {
        200: json('The updated cart', cartSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          404: ['CART_ITEM_NOT_FOUND'],
        }),
      },
    },
  },
};
