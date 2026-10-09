import { and, asc, count, desc, eq, gte, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteSelect } from 'drizzle-orm/sqlite-core';
import { db } from '#db/index.js';
import { ApiError } from '#middlewares/error.middleware.js';
import { categories, productImages, products, productVariants, reviews } from '#db/schema.js';
import type { ListProductsQuery } from './products.types.js';

const SORT_COLUMNS = {
  name: products.name,
  price: products.basePrice,
  category: categories.name,
};

// Unrounded average review rating per product; products without reviews have no row.
const ratings = db
  .select({
    productId: reviews.productId,
    averageRating: sql<number>`round(avg(${reviews.rating}), 2)`.as('average_rating'),
  })
  .from(reviews)
  .groupBy(reviews.productId)
  .as('ratings');

// Inner join, so a rating filter excludes products that have no reviews.
function withRatings<T extends SQLiteSelect>(qb: T) {
  return qb.innerJoin(ratings, eq(ratings.productId, products.id));
}

// Escape LIKE wildcards so user input is matched literally.
function toLikePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

export async function listProducts(query: ListProductsQuery) {
  // Only published products are visible in the public catalog.
  const conditions: SQL[] = [eq(products.status, 'active')];

  if (query.category) {
    const selectedCategory = db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, query.category));

    const matchingCategoryIds = db
      .select({ id: categories.id })
      .from(categories)
      .where(
        or(eq(categories.slug, query.category), inArray(categories.parentId, selectedCategory)),
      );
    conditions.push(inArray(products.categoryId, matchingCategoryIds));
  }
  if (query.search) {
    conditions.push(sql`${products.name} LIKE ${toLikePattern(query.search)} ESCAPE '\\'`);
  }
  if (query.min_price !== undefined) {
    conditions.push(gte(products.basePrice, query.min_price));
  }
  if (query.max_price !== undefined) {
    conditions.push(lte(products.basePrice, query.max_price));
  }
  const hasRatingFilter = query.min_rating !== undefined || query.max_rating !== undefined;
  if (query.min_rating !== undefined) {
    conditions.push(gte(ratings.averageRating, query.min_rating));
  }
  if (query.max_rating !== undefined) {
    conditions.push(lte(ratings.averageRating, query.max_rating));
  }

  const where = and(...conditions);
  const direction = query.order === 'desc' ? desc : asc;

  let rowsQuery = db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      description: products.description,
      basePrice: products.basePrice,
      category: categories.name,
      status: products.status,
      // The rating is only joined in, and so only returned, when filtering on it.
      ...(hasRatingFilter ? { averageRating: ratings.averageRating } : {}),
    })
    .from(products)
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .$dynamic();
  let countQuery = db.select({ total: count() }).from(products).$dynamic();
  if (hasRatingFilter) {
    rowsQuery = withRatings(rowsQuery);
    countQuery = withRatings(countQuery);
  }

  const rows = await rowsQuery
    .where(where)
    // Tie-break on id so pages stay stable when sort values repeat.
    .orderBy(direction(SORT_COLUMNS[query.sort]), asc(products.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit);

  const [{ total } = { total: 0 }] = await countQuery.where(where);

  const images =
    rows.length > 0
      ? await db
          .select({
            id: productImages.id,
            productId: productImages.productId,
            url: productImages.url,
          })
          .from(productImages)
          .where(
            inArray(
              productImages.productId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(productImages.position), asc(productImages.id))
      : [];

  const imagesByProduct = new Map<number, Array<{ id: number; url: string }>>();
  for (const { productId, ...image } of images) {
    const list = imagesByProduct.get(productId) ?? [];
    list.push(image);
    imagesByProduct.set(productId, list);
  }

  return {
    items: rows.map((row) => ({ ...row, images: imagesByProduct.get(row.id) ?? [] })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function getProductBySlug(slug: string) {
  // Same visibility rule as the listing: drafts/archived products are not public.
  const product = await db.query.products.findFirst({
    columns: {
      id: true,
      name: true,
      slug: true,
      description: true,
      basePrice: true,
      status: true,
    },
    where: and(eq(products.slug, slug), eq(products.status, 'active')),
    with: {
      category: { columns: { id: true, name: true, slug: true } },
      images: {
        columns: { id: true, url: true },
        orderBy: [asc(productImages.position), asc(productImages.id)],
      },
      // Variant price/stock are authoritative; basePrice is only a display price.
      variants: {
        columns: { id: true, sku: true, price: true, attributes: true, stockQuantity: true },
        orderBy: [asc(productVariants.price), asc(productVariants.id)],
      },
    },
  });

  if (!product) {
    throw new ApiError(404, 'NOT_FOUND', 'Product not found');
  }

  return {
    ...product,
    variants: product.variants.map(({ stockQuantity, ...variant }) => ({
      ...variant,
      inStock: stockQuantity > 0,
    })),
  };
}
