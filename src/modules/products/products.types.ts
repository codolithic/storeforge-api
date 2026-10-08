import { z } from 'zod';

export const listProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    // Category slug; a parent category also matches products in its subcategories.
    category: z.string().trim().min(1).optional(),
    search: z.string().trim().min(1).max(100).optional(),
    min_price: z.coerce.number().min(0).optional(),
    max_price: z.coerce.number().min(0).optional(),
    // Bounds on the product's average review rating (1-5); unreviewed products never match.
    min_rating: z.coerce.number().min(1).max(5).optional(),
    max_rating: z.coerce.number().min(1).max(5).optional(),
    sort: z.enum(['name', 'price', 'category']).default('name'),
    order: z.enum(['asc', 'desc']).default('asc'),
  })
  .refine(
    (q) => q.min_price === undefined || q.max_price === undefined || q.min_price <= q.max_price,
    { message: 'min_price must be less than or equal to max_price', path: ['min_price'] },
  )
  .refine(
    (q) => q.min_rating === undefined || q.max_rating === undefined || q.min_rating <= q.max_rating,
    { message: 'min_rating must be less than or equal to max_rating', path: ['min_rating'] },
  );

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productSlugParamsSchema = z.object({
  slug: z.string().trim().min(1).max(200),
});

export type ProductSlugParams = z.infer<typeof productSlugParamsSchema>;
