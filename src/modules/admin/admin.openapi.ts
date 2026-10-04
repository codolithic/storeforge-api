import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { bearerAuth, errors, json } from '../../docs/openapi.helpers.js';

// TODO: document real request/response schemas when admin.routes.ts stops
// returning dummy data. Until then the shapes below mirror the placeholders.
const PLACEHOLDER = 'Placeholder: not implemented yet, returns dummy data.';

const anyBody = z.record(z.string(), z.unknown());
const idParams = z.object({ id: z.string() });
const adminErrors = errors({ 401: ['UNAUTHORIZED'], 403: ['FORBIDDEN'] });

export const adminPaths: ZodOpenApiPathsObject = {
  '/api/admin/products': {
    post: {
      tags: ['Admin'],
      operationId: 'adminCreateProduct',
      summary: 'Create a product (placeholder)',
      description: PLACEHOLDER,
      security: bearerAuth,
      requestBody: { content: { 'application/json': { schema: anyBody } } },
      responses: {
        201: json('Dummy response', z.object({ message: z.string(), product: z.unknown() })),
        ...adminErrors,
      },
    },
  },
  '/api/admin/products/{id}': {
    patch: {
      tags: ['Admin'],
      operationId: 'adminUpdateProduct',
      summary: 'Update a product (placeholder)',
      description: PLACEHOLDER,
      security: bearerAuth,
      requestParams: { path: idParams },
      requestBody: { content: { 'application/json': { schema: anyBody } } },
      responses: {
        200: json('Dummy response', z.object({ message: z.string(), changes: z.unknown() })),
        ...adminErrors,
      },
    },
  },
  '/api/admin/orders': {
    get: {
      tags: ['Admin'],
      operationId: 'adminListOrders',
      summary: 'List all orders (placeholder)',
      description: PLACEHOLDER,
      security: bearerAuth,
      responses: {
        200: json(
          'Dummy response',
          z.array(z.object({ id: z.number(), status: z.string(), userId: z.number() })),
        ),
        ...adminErrors,
      },
    },
  },
  '/api/admin/orders/{id}/status': {
    patch: {
      tags: ['Admin'],
      operationId: 'adminUpdateOrderStatus',
      summary: 'Change an order’s status (placeholder)',
      description: PLACEHOLDER,
      security: bearerAuth,
      requestParams: { path: idParams },
      requestBody: { content: { 'application/json': { schema: anyBody } } },
      responses: {
        200: json('Dummy response', z.object({ message: z.string(), changes: z.unknown() })),
        ...adminErrors,
      },
    },
  },
};
