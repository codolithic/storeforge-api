import { Router } from 'express';
import { authenticate } from '@middlewares/auth.middleware.js';
import { validateBody, validateParams, validateQuery } from '@middlewares/validate.middleware.js';
import * as ordersController from './orders.controller.js';
import { checkoutSchema, listOrdersQuerySchema, orderParamsSchema } from './orders.types.js';

const router = Router();

// Every order route requires a logged-in customer.
router.use(authenticate);

router.post('/', validateBody(checkoutSchema), ordersController.checkout);
router.get('/', validateQuery(listOrdersQuerySchema), ordersController.listMyOrders);
router.get('/:id', validateParams(orderParamsSchema), ordersController.getOrder);
router.post('/:id/cancel', validateParams(orderParamsSchema), ordersController.cancelOrder);

export default router;
