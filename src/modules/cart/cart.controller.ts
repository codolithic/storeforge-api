import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';

// TODO: replace with real Drizzle queries against carts/cart_items,
// scoped to req.user!.id, once catalog + cart data are seeded.
const dummyCart = {
  id: 1,
  items: [{ id: 1, variantId: 10, quantity: 2, unitPriceSnapshot: 79.99 }],
};

export async function getCart(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, dummyCart);
}

export async function addItem(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { message: 'Item added to cart (dummy)', item: req.body }, 201);
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { message: `Item ${req.params.id} updated (dummy)`, changes: req.body });
}

export async function removeItem(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { message: `Item ${req.params.id} removed (dummy)` });
}
