import { Router } from 'express';
import * as productsController from './products.controller.js';
import { validateParams, validateQuery } from '../../middlewares/validate.middleware.js';
import { listProductsQuerySchema, productSlugParamsSchema } from './products.types.js';

const router = Router();

router.get('/', validateQuery(listProductsQuerySchema), productsController.listProducts);
router.get('/:slug', validateParams(productSlugParamsSchema), productsController.getProductBySlug);

export default router;
