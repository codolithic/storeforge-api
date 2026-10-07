import { and, desc, eq } from 'drizzle-orm';
import { db } from '@db/index.js';
import { cartItems, carts, products, productVariants } from '@db/schema.js';
import { ApiError } from '@middlewares/error.middleware.js';
import { MAX_ITEM_QUANTITY } from './cart.types.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Money is stored as SQLite `real`, so round derived totals to cents.
export const roundMoney = (amount: number) => Math.round(amount * 100) / 100;

export const activeCartOf = (userId: number) =>
  and(eq(carts.userId, userId), eq(carts.status, 'active'));

export function findActiveCartId(tx: Tx, userId: number) {
  return tx
    .select({ id: carts.id })
    .from(carts)
    .where(activeCartOf(userId))
    .orderBy(desc(carts.id))
    .get()?.id;
}

// Price and stock come from the variant; only active products can be bought.
export function findPurchasableVariant(tx: Tx, variantId: number) {
  const variant = tx
    .select({
      id: productVariants.id,
      price: productVariants.price,
      stockQuantity: productVariants.stockQuantity,
      productStatus: products.status,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .get();

  if (!variant || variant.productStatus !== 'active') {
    throw new ApiError(404, 'VARIANT_NOT_FOUND', 'Product variant not found');
  }
  return variant;
}

export function assertQuantityAllowed(quantity: number, stockQuantity: number) {
  if (quantity > MAX_ITEM_QUANTITY) {
    throw new ApiError(
      400,
      'QUANTITY_LIMIT_EXCEEDED',
      `A cart line can hold at most ${MAX_ITEM_QUANTITY} units`,
    );
  }
  if (quantity > stockQuantity) {
    throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for the requested quantity');
  }
}

// Only items in the caller's own active cart are addressable; anything else is a 404
// so item ids belonging to other users aren't revealed.
export function findOwnedItem(tx: Tx, userId: number, itemId: number) {
  const item = tx
    .select({ id: cartItems.id, variantId: cartItems.variantId })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(and(eq(cartItems.id, itemId), activeCartOf(userId)))
    .get();

  if (!item) {
    throw new ApiError(404, 'CART_ITEM_NOT_FOUND', 'Cart item not found');
  }
  return item;
}
