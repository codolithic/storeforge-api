import { Router } from 'express';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../../middlewares/validate.middleware.js';
import * as paymentsController from './payments.controller.js';
import {
  createPaymentSchema,
  listPaymentsQuerySchema,
  paymentParamsSchema,
} from './payments.types.js';

const router = Router();

// Every payment route requires a logged-in user; refunds are admin-only.
router.use(authenticate);

router.post('/', validateBody(createPaymentSchema), paymentsController.createPayment);
router.get('/', validateQuery(listPaymentsQuerySchema), paymentsController.listMyPayments);
router.get('/:id', validateParams(paymentParamsSchema), paymentsController.getPayment);
router.post(
  '/:id/refund',
  authorize('admin'),
  validateParams(paymentParamsSchema),
  paymentsController.refundPayment,
);

export default router;
