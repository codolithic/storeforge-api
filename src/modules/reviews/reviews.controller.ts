import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as reviewsService from './reviews.service.js';
import type {
  CreateReviewInput,
  ListMyReviewsQuery,
  ListReviewsQuery,
  ReviewParams,
  UpdateReviewInput,
} from './reviews.types.js';

// req.user is set on every handler below except listProductReviews (public).

export async function listProductReviews(_req: Request, res: Response): Promise<void> {
  const result = await reviewsService.listProductReviews(res.locals.query as ListReviewsQuery);
  sendSuccess(res, result);
}

export async function listMyReviews(req: Request, res: Response): Promise<void> {
  const result = await reviewsService.listMyReviews(
    req.user!.id,
    res.locals.query as ListMyReviewsQuery,
  );
  sendSuccess(res, result);
}

export async function createReview(req: Request, res: Response): Promise<void> {
  const review = await reviewsService.createReview(req.user!.id, req.body as CreateReviewInput);
  sendSuccess(res, review, 201);
}

export async function updateReview(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as ReviewParams;
  const review = await reviewsService.updateReview(req.user!.id, id, req.body as UpdateReviewInput);
  sendSuccess(res, review);
}

export async function deleteReview(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as ReviewParams;
  const result = await reviewsService.deleteReview(req.user!, id);
  sendSuccess(res, result);
}
