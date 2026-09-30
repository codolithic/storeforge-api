import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/apiResponse.js';
import * as productsService from './products.service.js';
import type { ListProductsQuery } from './products.types.js';

// TODO: replace getProductBySlug's dummy data with real Drizzle queries
// against products/product_variants.
const dummyProducts = [
  {
    id: 1,
    name: 'Wireless Headphones',
    slug: 'wireless-headphones',
    basePrice: 79.99,
    status: 'active',
  },
  {
    id: 2,
    name: 'Mechanical Keyboard',
    slug: 'mechanical-keyboard',
    basePrice: 129.99,
    status: 'active',
  },
  {
    id: 3,
    name: 'USB-C Charging Cable',
    slug: 'usb-c-charging-cable',
    basePrice: 12.99,
    status: 'active',
  },
];

export async function listProducts(_req: Request, res: Response): Promise<void> {
  const result = await productsService.listProducts(res.locals.query as ListProductsQuery);
  sendSuccess(res, result);
}

export async function getProductBySlug(req: Request, res: Response): Promise<void> {
  const product = dummyProducts.find((p) => p.slug === req.params.slug);
  if (!product) {
    sendError(res, 404, 'NOT_FOUND', 'Product not found');
    return;
  }
  sendSuccess(res, product);
}
