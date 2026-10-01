import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as categoriesService from './categories.service.js';

export async function listCategories(_req: Request, res: Response): Promise<void> {
  const menu = await categoriesService.listCategories();
  sendSuccess(res, menu);
}
