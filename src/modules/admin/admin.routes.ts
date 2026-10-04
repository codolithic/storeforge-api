import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../../middlewares/validate.middleware.js';
import * as adminController from './admin.controller.js';
import {
  adminIdParamsSchema,
  createProductSchema,
  listAdminOrdersQuerySchema,
  updateOrderStatusSchema,
  updateProductSchema,
} from './admin.types.js';

const router = Router();

// Every admin route requires a logged-in user with the 'admin' role.
router.use(authenticate, authorize('admin'));

router.post('/products', validateBody(createProductSchema), adminController.createProduct);
router.patch(
  '/products/:id',
  validateParams(adminIdParamsSchema),
  validateBody(updateProductSchema),
  adminController.updateProduct,
);

router.get('/orders', validateQuery(listAdminOrdersQuerySchema), adminController.listOrders);
router.patch(
  '/orders/:id/status',
  validateParams(adminIdParamsSchema),
  validateBody(updateOrderStatusSchema),
  adminController.updateOrderStatus,
);

export default router;
