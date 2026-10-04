import { z } from 'zod';

const PRODUCT_STATUSES = ['active', 'draft', 'archived'] as const;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase words separated by hyphens');

const price = z.number().min(0);

const productFields = {
  name: z.string().trim().min(1).max(200),
  slug,
  description: z.string().trim().min(1).max(5000).nullable(),
  basePrice: price,
  categoryId: z.number().int().positive().nullable(),
  status: z.enum(PRODUCT_STATUSES),
};

const variantSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  price,
  attributes: z.record(z.string(), z.string()).nullable().optional(),
  stockQuantity: z.number().int().min(0).default(0),
});

const imageSchema = z.object({
  url: z.url().max(2000),
  position: z.number().int().min(0).default(0),
});

// Variants carry the sellable price and stock, so a product is only purchasable
// once it has at least one. New products default to `draft`.
export const createProductSchema = z
  .object({
    ...productFields,
    description: productFields.description.optional(),
    categoryId: productFields.categoryId.optional(),
    status: productFields.status.default('draft'),
    variants: z.array(variantSchema).max(50).default([]),
    images: z.array(imageSchema).max(20).default([]),
  })
  .refine((body) => new Set(body.variants.map((v) => v.sku)).size === body.variants.length, {
    message: 'Variant SKUs must be unique',
    path: ['variants'],
  });

export type CreateProductInput = z.infer<typeof createProductSchema>;

// Product-level fields only; variants and images aren't editable here yet.
export const updateProductSchema = z
  .object(productFields)
  .partial()
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  });

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const listAdminOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']).optional(),
  userId: z.coerce.number().int().positive().optional(),
});

export type ListAdminOrdersQuery = z.infer<typeof listAdminOrdersQuerySchema>;

// `fulfilled` marks a paid order as shipped; `cancelled` cancels an unpaid one.
// Paid orders are cancelled by refunding the payment (POST /payments/:id/refund).
export const updateOrderStatusSchema = z.object({
  status: z.enum(['fulfilled', 'cancelled']),
});

export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;

export const adminIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type AdminIdParams = z.infer<typeof adminIdParamsSchema>;
