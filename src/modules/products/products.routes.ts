import { Router } from 'express';
import * as productsController from './products.controller.js';

const router = Router();

router.get('/', productsController.listProducts);
router.get('/:slug', productsController.getProductBySlug);

export default router;
