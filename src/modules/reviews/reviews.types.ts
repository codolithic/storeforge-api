import { z } from 'zod';

const rating = z.number().int().min(1).max(5);
// null clears the comment on update; empty strings are rejected rather than stored.
const comment = z.string().trim().min(1).max(2000).nullable();

export const listReviewsQuerySchema = z.object({
  productId: z.coerce.number().int().positive(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  rating: z.coerce.number().int().min(1).max(5).optional(),
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

export const listMyReviewsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListMyReviewsQuery = z.infer<typeof listMyReviewsQuerySchema>;

export const createReviewSchema = z.object({
  productId: z.number().int().positive(),
  rating,
  comment: comment.optional(),
});

export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const updateReviewSchema = z
  .object({ rating: rating.optional(), comment: comment.optional() })
  .refine((body) => body.rating !== undefined || body.comment !== undefined, {
    message: 'Provide rating and/or comment',
    path: ['rating'],
  });

export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;

export const reviewParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type ReviewParams = z.infer<typeof reviewParamsSchema>;
