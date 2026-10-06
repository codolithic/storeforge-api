import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import { validateParams, validateQuery } from '../../middlewares/validate.middleware.js';
import * as paymentsController from './payments.controller.js';
import { listPaymentsQuerySchema, paymentParamsSchema } from './payments.types.js';

const router = Router();

// Every payment route requires a logged-in user; refunds are admin-only.
// Payments are created by checkout (POST /orders), not through this router.
router.use(authenticate);

router.get('/', validateQuery(listPaymentsQuerySchema), paymentsController.listMyPayments);
router.get('/:id', validateParams(paymentParamsSchema), paymentsController.getPayment);
router.post(
  '/:id/refund',
  authorize('admin'),
  validateParams(paymentParamsSchema),
  paymentsController.refundPayment,
);

export default router;
