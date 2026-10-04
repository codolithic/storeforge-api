import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { json } from '../../docs/openapi.helpers.js';

// Not pinned with Documents<>: the `Menu` type is recursive (subMenu: Menu[] | null),
// while the documented shape spells out the two levels the menu builder produces.
const subcategorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  subMenu: z.null(),
});

const categorySchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    slug: z.string(),
    subMenu: z.array(subcategorySchema),
  })
  .meta({ id: 'CategoryMenu' });

export const categoryPaths: ZodOpenApiPathsObject = {
  '/api/categories': {
    get: {
      tags: ['Catalog'],
      operationId: 'listCategories',
      security: [],
      summary: 'Category menu',
      description: 'Root categories, each with its subcategories (two levels).',
      responses: {
        200: json('Category menu', z.array(categorySchema)),
      },
    },
  },
};
