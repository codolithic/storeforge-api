import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import { adminPaths } from '../modules/admin/admin.openapi.js';
import { authPaths } from '../modules/auth/auth.openapi.js';
import { cartPaths } from '../modules/cart/cart.openapi.js';
import { categoryPaths } from '../modules/categories/categories.openapi.js';
import { orderPaths } from '../modules/orders/orders.openapi.js';
import { paymentPaths } from '../modules/payments/payments.openapi.js';
import { productPaths } from '../modules/products/products.openapi.js';
import { reviewPaths } from '../modules/reviews/reviews.openapi.js';

// Paths are absolute (`/api/...`) so `/health`, which sits outside `/api`, fits
// in the same document and "try it" requests go to the serving origin.
export function buildOpenApiDocument() {
  return createDocument({
    openapi: '3.1.0',
    info: {
      title: 'StoreForge API',
      version: '0.1.0',
      description:
        'Sample e-commerce backend. Successful responses are `{ success: true, data }`; errors are `{ success: false, error: { code, message } }`. Send the access token from login/register as `Authorization: Bearer <token>`; the refresh token travels in an httpOnly `refresh_token` cookie.',
    },
    servers: [{ url: '/', description: 'The server hosting these docs' }],
    tags: [
      { name: 'Health', description: 'Liveness probe' },
      { name: 'Auth', description: 'Registration, login and refresh-token rotation' },
      { name: 'Catalog', description: 'Products and categories (public)' },
      { name: 'Cart', description: 'The caller’s active cart' },
      { name: 'Orders', description: 'Checkout and the caller’s orders' },
      { name: 'Payments', description: 'Payments against a simulated gateway' },
      { name: 'Reviews', description: 'Product reviews from verified buyers' },
      { name: 'Admin', description: 'Admin role required' },
    ],
    paths: {
      '/health': {
        get: {
          tags: ['Health'],
          operationId: 'health',
          security: [],
          summary: 'Liveness check',
          description: 'Not wrapped in the response envelope.',
          responses: {
            200: {
              description: 'The server is up',
              content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
            },
          },
        },
      },
      ...authPaths,
      ...productPaths,
      ...categoryPaths,
      ...cartPaths,
      ...orderPaths,
      ...paymentPaths,
      ...reviewPaths,
      ...adminPaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
      },
    },
  });
}
