import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as productsService from './products.service.js';
import type { ListProductsQuery, ProductSlugParams } from './products.types.js';

export async function listProducts(_req: Request, res: Response): Promise<void> {
  const result = await productsService.listProducts(res.locals.query as ListProductsQuery);
  sendSuccess(res, result);
}

export async function getProductBySlug(_req: Request, res: Response): Promise<void> {
  const { slug } = res.locals.params as ProductSlugParams;
  const product = await productsService.getProductBySlug(slug);
  sendSuccess(res, product);
}
