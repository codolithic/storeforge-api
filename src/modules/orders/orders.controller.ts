import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as ordersService from './orders.service.js';
import type { CheckoutInput, ListOrdersQuery, OrderParams } from './orders.types.js';

// req.user is always set here: every order route sits behind `authenticate`.

export async function checkout(req: Request, res: Response): Promise<void> {
  const order = await ordersService.checkout(req.user!.id, req.body as CheckoutInput);
  sendSuccess(res, order, 201);
}

export async function listMyOrders(req: Request, res: Response): Promise<void> {
  const result = await ordersService.listOrders(req.user!.id, res.locals.query as ListOrdersQuery);
  sendSuccess(res, result);
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as OrderParams;
  const order = await ordersService.getOrder(req.user!.id, id);
  sendSuccess(res, order);
}

export async function cancelOrder(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as OrderParams;
  const order = await ordersService.cancelOrder(req.user!.id, id);
  sendSuccess(res, order);
}
