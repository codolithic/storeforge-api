import { Router } from 'express';
import { authenticate } from '../../middlewares/auth.middleware.js';
import {
  validateBody,
  validateParams,
  validateQuery,
} from '../../middlewares/validate.middleware.js';
import * as reviewsController from './reviews.controller.js';
import {
  createReviewSchema,
  listMyReviewsQuerySchema,
  listReviewsQuerySchema,
  reviewParamsSchema,
  updateReviewSchema,
} from './reviews.types.js';

const router = Router();

// Reading a product's reviews is public; everything else requires login.
router.get('/', validateQuery(listReviewsQuerySchema), reviewsController.listProductReviews);

router.get(
  '/me',
  authenticate,
  validateQuery(listMyReviewsQuerySchema),
  reviewsController.listMyReviews,
);
router.post('/', authenticate, validateBody(createReviewSchema), reviewsController.createReview);
router.patch(
  '/:id',
  authenticate,
  validateParams(reviewParamsSchema),
  validateBody(updateReviewSchema),
  reviewsController.updateReview,
);
router.delete(
  '/:id',
  authenticate,
  validateParams(reviewParamsSchema),
  reviewsController.deleteReview,
);

export default router;
