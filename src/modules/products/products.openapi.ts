import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  attributes,
  errors,
  json,
  paginated,
  type Assert,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as productsService from './products.service.js';
import { listProductsQuerySchema, productSlugParamsSchema } from './products.types.js';

const imageSchema = z
  .object({ id: z.number().int(), url: z.string() })
  .meta({ id: 'ProductImage' });

const productSummarySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    basePrice: z
      .number()
      .meta({ description: 'Display/starting price; variants set the real price' }),
    category: z.string().nullable().meta({ description: 'Category name' }),
    status: z.enum(['active', 'draft', 'archived']),
    images: z.array(imageSchema),
  })
  .meta({ id: 'ProductSummary' });

const productListSchema = paginated(productSummarySchema);

const productDetailSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    basePrice: z.number(),
    status: z.enum(['active', 'draft', 'archived']),
    category: z.object({ id: z.number().int(), name: z.string(), slug: z.string() }).nullable(),
    images: z.array(imageSchema),
    variants: z.array(
      z.object({
        id: z.number().int(),
        sku: z.string(),
        price: z.number(),
        attributes,
        inStock: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ProductDetail' });

type _list = Assert<
  Documents<typeof productListSchema, ReturnOf<typeof productsService.listProducts>>
>;
type _detail = Assert<
  Documents<typeof productDetailSchema, ReturnOf<typeof productsService.getProductBySlug>>
>;

export const productPaths: ZodOpenApiPathsObject = {
  '/api/products': {
    get: {
      tags: ['Catalog'],
      operationId: 'listProducts',
      security: [],
      summary: 'List active products',
      description:
        'Paginated. `category` is a category slug and also matches its subcategories; `search` matches the name literally. `min_price` must be ≤ `max_price` (both filter on `basePrice`).',
      requestParams: { query: listProductsQuerySchema },
      responses: {
        200: json('A page of products', productListSchema),
        ...errors({ 400: ['VALIDATION_ERROR'] }),
      },
    },
  },
  '/api/products/{slug}': {
    get: {
      tags: ['Catalog'],
      operationId: 'getProductBySlug',
      security: [],
      summary: 'Get an active product by slug',
      description: 'Variants report `inStock` instead of the raw stock count.',
      requestParams: { path: productSlugParamsSchema },
      responses: {
        200: json('The product', productDetailSchema),
        ...errors({ 400: ['VALIDATION_ERROR'], 404: ['NOT_FOUND'] }),
      },
    },
  },
};
