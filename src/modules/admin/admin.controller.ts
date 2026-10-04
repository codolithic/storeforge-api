import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as adminService from './admin.service.js';
import type {
  AdminIdParams,
  CreateProductInput,
  ListAdminOrdersQuery,
  UpdateOrderStatusInput,
  UpdateProductInput,
} from './admin.types.js';

// Every admin route sits behind `authenticate, authorize('admin')`.

export async function createProduct(req: Request, res: Response): Promise<void> {
  const result = await adminService.createProduct(req.body as CreateProductInput);
  sendSuccess(res, result, 201);
}

export async function updateProduct(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as AdminIdParams;
  const result = await adminService.updateProduct(id, req.body as UpdateProductInput);
  sendSuccess(res, result);
}

export async function listOrders(_req: Request, res: Response): Promise<void> {
  const result = await adminService.listOrders(res.locals.query as ListAdminOrdersQuery);
  sendSuccess(res, result);
}

export async function updateOrderStatus(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as AdminIdParams;
  const result = await adminService.updateOrderStatus(id, req.body as UpdateOrderStatusInput);
  sendSuccess(res, result);
}
