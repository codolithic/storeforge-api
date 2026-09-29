import type { Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import { sendSuccess, sendError } from '../../utils/apiResponse.js';
import { db, products as productsTable, categories as categoriesTable } from '../../db/index.js';

// TODO: replace with real Drizzle queries against products/product_variants
// once catalog data is seeded.
const dummyProducts = [
  {
    id: 1,
    name: 'Wireless Headphones',
    slug: 'wireless-headphones',
    basePrice: 79.99,
    status: 'active',
  },
  {
    id: 2,
    name: 'Mechanical Keyboard',
    slug: 'mechanical-keyboard',
    basePrice: 129.99,
    status: 'active',
  },
  {
    id: 3,
    name: 'USB-C Charging Cable',
    slug: 'usb-c-charging-cable',
    basePrice: 12.99,
    status: 'active',
  },
];

export async function listProducts(_req: Request, res: Response): Promise<void> {
  // Real version will support ?page, ?limit, ?category, ?search, ?minPrice, ?maxPrice, ?sort`
  const {
    page = 1,
    limit = 20,
    category,
    search,
    min_price: minPrice,
    max_price: maxPrice,
    sort = 'name',
  } = _req.query;

  const pageNumber = Number(page);
  const pageLimit = Number(limit);

  const unknownQueries = [];
  if (isNaN(pageNumber) || pageNumber <= 0) {
    unknownQueries.push('page');
  }

  if (isNaN(pageLimit) || pageLimit <= 0) {
    unknownQueries.push('limit');
  }

  if (sort && !['name', 'price', 'category'].includes(String(sort))) {
    unknownQueries.push('sort');
  }

  if (unknownQueries.length > 0) {
    return sendError(res, 400, 'INVALID_QUERY', `Invalid queries: ${unknownQueries.join(', ')}`);
  }

  const products = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      slug: productsTable.slug,
      description: productsTable.description,
      price: productsTable.basePrice,
      category: categoriesTable.name,
    })
    .from(productsTable)
    .leftJoin(categoriesTable, eq(categoriesTable.id, productsTable.categoryId))
    .orderBy(
      sort === 'name'
        ? productsTable.name
        : sort === 'price'
          ? productsTable.basePrice
          : sort === 'category'
            ? categoriesTable.name
            : productsTable.name,
    )
    .limit(pageLimit);

  sendSuccess(res, {
    items: products,
    pagination: { page: 1, limit: 20, total: dummyProducts.length },
  });
}

export async function getProductBySlug(req: Request, res: Response): Promise<void> {
  const product = dummyProducts.find((p) => p.slug === req.params.slug);
  if (!product) {
    sendError(res, 404, 'NOT_FOUND', 'Product not found');
    return;
  }
  sendSuccess(res, product);
}
