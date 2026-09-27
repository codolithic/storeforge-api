import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import * as cartController from './cart.controller.js';

const router = Router();

// Every cart route requires a logged-in customer.
router.use(authenticate);

router.get('/', cartController.getCart);
router.post('/items', cartController.addItem);
router.patch('/items/:id', cartController.updateItem);
router.delete('/items/:id', cartController.removeItem);

export default router;
