import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import { validateBody, validateParams } from '../../middlewares/validate.middleware.js';
import * as cartController from './cart.controller.js';
import { addCartItemSchema, cartItemParamsSchema, updateCartItemSchema } from './cart.types.js';

const router = Router();

// Every cart route requires a logged-in customer.
router.use(authenticate);

router.get('/', cartController.getCart);
router.post('/items', validateBody(addCartItemSchema), cartController.addItem);
router.patch(
  '/items/:id',
  validateParams(cartItemParamsSchema),
  validateBody(updateCartItemSchema),
  cartController.updateItem,
);
router.delete('/items/:id', validateParams(cartItemParamsSchema), cartController.removeItem);

export default router;
