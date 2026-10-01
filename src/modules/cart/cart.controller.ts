import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as cartService from './cart.service.js';
import type { AddCartItemInput, CartItemParams, UpdateCartItemInput } from './cart.types.js';

// req.user is always set here: every cart route sits behind `authenticate`.

export async function getCart(req: Request, res: Response): Promise<void> {
  const cart = await cartService.getCart(req.user!.id);
  sendSuccess(res, cart);
}

export async function addItem(req: Request, res: Response): Promise<void> {
  const { created, cart } = await cartService.addItem(req.user!.id, req.body as AddCartItemInput);
  sendSuccess(res, cart, created ? 201 : 200);
}

export async function updateItem(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as CartItemParams;
  const cart = await cartService.updateItem(req.user!.id, id, req.body as UpdateCartItemInput);
  sendSuccess(res, cart);
}

export async function removeItem(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as CartItemParams;
  const cart = await cartService.removeItem(req.user!.id, id);
  sendSuccess(res, cart);
}
