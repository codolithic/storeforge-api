import { Router } from 'express';
import * as productsController from './products.controller.js';
import { validateQuery } from '../../middlewares/validate.middleware.js';
import { listProductsQuerySchema } from './products.types.js';

const router = Router();

router.get('/', validateQuery(listProductsQuerySchema), productsController.listProducts);
router.get('/:slug', productsController.getProductBySlug);

export default router;
