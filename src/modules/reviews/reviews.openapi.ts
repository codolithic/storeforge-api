import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  bearerAuth,
  errors,
  json,
  paginated,
  timestamp,
  type Assert,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as reviewsService from './reviews.service.js';
import {
  createReviewSchema,
  listMyReviewsQuerySchema,
  listReviewsQuerySchema,
  reviewParamsSchema,
  updateReviewSchema,
} from './reviews.types.js';

const reviewFields = {
  id: z.number().int(),
  productId: z.number().int(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().nullable(),
  createdAt: timestamp,
};

const reviewSchema = z.object({ ...reviewFields, userId: z.number().int() }).meta({ id: 'Review' });

const publicReviewSchema = z
  .object({
    ...reviewFields,
    reviewer: z.string().meta({ description: '"First L." or "Anonymous"', example: 'Jane D.' }),
  })
  .meta({ id: 'PublicReview' });

const myReviewSchema = z
  .object({
    ...reviewFields,
    userId: z.number().int(),
    productName: z.string(),
    productSlug: z.string(),
  })
  .meta({ id: 'MyReview' });

const publicListSchema = paginated(publicReviewSchema);
const myListSchema = paginated(myReviewSchema);
const deletedSchema = z.object({ id: z.number().int() });

type _create = Assert<Documents<typeof reviewSchema, ReturnOf<typeof reviewsService.createReview>>>;
type _update = Assert<Documents<typeof reviewSchema, ReturnOf<typeof reviewsService.updateReview>>>;
type _delete = Assert<
  Documents<typeof deletedSchema, ReturnOf<typeof reviewsService.deleteReview>>
>;
type _public = Assert<
  Documents<typeof publicListSchema, ReturnOf<typeof reviewsService.listProductReviews>>
>;
type _mine = Assert<Documents<typeof myListSchema, ReturnOf<typeof reviewsService.listMyReviews>>>;

const ownReviewErrors = errors({
  400: ['VALIDATION_ERROR'],
  401: ['UNAUTHORIZED'],
  404: ['REVIEW_NOT_FOUND'],
});

export const reviewPaths: ZodOpenApiPathsObject = {
  '/api/reviews': {
    get: {
      tags: ['Reviews'],
      operationId: 'listProductReviews',
      security: [],
      summary: 'List an active product’s reviews',
      description: 'Public. Newest first, optionally filtered by `rating`.',
      requestParams: { query: listReviewsQuerySchema },
      responses: {
        200: json('A page of reviews', publicListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 404: ['PRODUCT_NOT_FOUND'] }),
      },
    },
    post: {
      tags: ['Reviews'],
      operationId: 'createReview',
      summary: 'Review a purchased product',
      description:
        'Requires a `fulfilled` order containing any variant of the product. One review per user per product.',
      security: bearerAuth,
      requestBody: { content: { 'application/json': { schema: createReviewSchema } } },
      responses: {
        201: json('The new review', reviewSchema),
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['UNAUTHORIZED'],
          403: ['REVIEW_NOT_ALLOWED'],
          404: ['PRODUCT_NOT_FOUND'],
          409: ['REVIEW_EXISTS'],
        }),
      },
    },
  },
  '/api/reviews/me': {
    get: {
      tags: ['Reviews'],
      operationId: 'listMyReviews',
      summary: 'List the caller’s reviews',
      description: 'Newest first.',
      security: bearerAuth,
      requestParams: { query: listMyReviewsQuerySchema },
      responses: {
        200: json('A page of the caller’s reviews', myListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 401: ['UNAUTHORIZED'] }),
      },
    },
  },
  '/api/reviews/{id}': {
    patch: {
      tags: ['Reviews'],
      operationId: 'updateReview',
      summary: 'Edit your review',
      description:
        'Author only; other users’ reviews are 404. Send at least one of `rating`/`comment`; `comment: null` clears it.',
      security: bearerAuth,
      requestParams: { path: reviewParamsSchema },
      requestBody: { content: { 'application/json': { schema: updateReviewSchema } } },
      responses: { 200: json('The updated review', reviewSchema), ...ownReviewErrors },
    },
    delete: {
      tags: ['Reviews'],
      operationId: 'deleteReview',
      summary: 'Delete a review',
      description: 'The author can delete their own review; admins can delete any.',
      security: bearerAuth,
      requestParams: { path: reviewParamsSchema },
      responses: { 200: json('The deleted review id', deletedSchema), ...ownReviewErrors },
    },
  },
};
