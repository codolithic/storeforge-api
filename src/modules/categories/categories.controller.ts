import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';

// TODO: replace with real Drizzle query against categories once seeded.
const dummyCategories = [
  { id: 1, name: 'Electronics', slug: 'electronics' },
  { id: 2, name: 'Accessories', slug: 'accessories' },
  { id: 3, name: 'Audio', slug: 'audio' },
];

export async function listCategories(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, dummyCategories);
}
