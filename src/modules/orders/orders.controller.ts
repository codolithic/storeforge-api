import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';

// TODO: replace with real order-creation logic (from the user's cart),
// the order state machine, and Drizzle queries once data is seeded.
const dummyOrders = [
  { id: 101, status: 'pending', total: 159.98, createdAt: new Date().toISOString() },
];

export async function checkout(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { message: 'Order created (dummy)', order: dummyOrders[0] }, 201);
}

export async function listMyOrders(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, dummyOrders);
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const order = dummyOrders.find((o) => o.id === Number(req.params.id)) ?? null;
  sendSuccess(res, order);
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  sendSuccess(res, { message: `Order ${req.params.id} cancelled (dummy)` });
}
