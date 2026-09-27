import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import * as ordersController from './orders.controller.js';

const router = Router();

// Every order route requires a logged-in customer.
router.use(authenticate);

router.post('/', ordersController.checkout);
router.get('/', ordersController.listMyOrders);
router.get('/:id', ordersController.getOrder);
router.post('/:id/cancel', ordersController.cancelOrder);

export default router;
