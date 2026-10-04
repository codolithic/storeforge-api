import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import productRoutes from '../modules/products/products.routes.js';
import categoryRoutes from '../modules/categories/categories.routes.js';
import cartRoutes from '../modules/cart/cart.routes.js';
import orderRoutes from '../modules/orders/orders.routes.js';
import paymentRoutes from '../modules/payments/payments.routes.js';
import reviewRoutes from '../modules/reviews/reviews.routes.js';
import adminRoutes from '../modules/admin/admin.routes.js';

// Exported so tests can walk every mounted route (Express doesn't keep mount
// paths on its router layers) and check each one is in the OpenAPI document.
export const mounts: ReadonlyArray<readonly [path: string, router: Router]> = [
  ['/auth', authRoutes],
  ['/products', productRoutes],
  ['/categories', categoryRoutes],
  ['/cart', cartRoutes],
  ['/orders', orderRoutes],
  ['/payments', paymentRoutes],
  ['/reviews', reviewRoutes],
  ['/admin', adminRoutes],
];

const router = Router();

for (const [path, moduleRouter] of mounts) {
  router.use(path, moduleRouter);
}

export default router;
