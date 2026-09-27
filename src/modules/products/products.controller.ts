import type { Request, Response } from 'express';
import { sendSuccess, sendError } from '../../utils/apiResponse.js';

// TODO: replace with real Drizzle queries against products/product_variants
// once catalog data is seeded.
const dummyProducts = [
  { id: 1, name: 'Wireless Headphones', slug: 'wireless-headphones', basePrice: 79.99, status: 'active' },
  { id: 2, name: 'Mechanical Keyboard', slug: 'mechanical-keyboard', basePrice: 129.99, status: 'active' },
  { id: 3, name: 'USB-C Charging Cable', slug: 'usb-c-charging-cable', basePrice: 12.99, status: 'active' },
];

export async function listProducts(_req: Request, res: Response): Promise<void> {
  // Real version will support ?page, ?limit, ?category, ?search, ?minPrice, ?maxPrice, ?sort
  sendSuccess(res, {
    items: dummyProducts,
    pagination: { page: 1, limit: 20, total: dummyProducts.length },
  });
}

export async function getProductBySlug(req: Request, res: Response): Promise<void> {
  const product = dummyProducts.find((p) => p.slug === req.params.slug);
  if (!product) {
    sendError(res, 404, 'NOT_FOUND', 'Product not found');
    return;
  }
  sendSuccess(res, product);
}
