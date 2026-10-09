import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '#db/index.js';
import { cartItems, carts } from '#db/schema.js';
import { type AddCartItemInput, type UpdateCartItemInput } from './cart.types.js';
import {
  activeCartOf,
  assertQuantityAllowed,
  findActiveCartId,
  findOwnedItem,
  findPurchasableVariant,
  roundMoney,
} from './cart.utils.js';

export async function getCart(userId: number) {
  const cart = await db.query.carts.findFirst({
    columns: { id: true },
    where: activeCartOf(userId),
    orderBy: desc(carts.id),
    with: {
      items: {
        columns: { id: true, quantity: true, unitPriceSnapshot: true },
        orderBy: asc(cartItems.id),
        with: {
          variant: {
            columns: { id: true, sku: true, attributes: true, stockQuantity: true },
            with: { product: { columns: { id: true, name: true, slug: true, status: true } } },
          },
        },
      },
    },
  });

  // No cart is created on read; it appears with the first added item.
  if (!cart) {
    return { id: null, items: [], itemCount: 0, subtotal: 0 };
  }

  const items = cart.items.map(({ variant, ...item }) => {
    const { status, ...product } = variant.product;
    return {
      id: item.id,
      variantId: variant.id,
      sku: variant.sku,
      attributes: variant.attributes,
      product,
      quantity: item.quantity,
      unitPriceSnapshot: item.unitPriceSnapshot,
      lineTotal: roundMoney(item.unitPriceSnapshot * item.quantity),
      // Lets the client flag lines that can no longer be checked out as-is.
      available: status === 'active' && variant.stockQuantity >= item.quantity,
    };
  });

  return {
    id: cart.id,
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0)),
  };
}

// Adding a variant already in the cart merges into the existing line. Runs as a
// synchronous better-sqlite3 transaction so get-or-create of the cart and the
// line can't interleave with a concurrent request and produce duplicates.
export async function addItem(userId: number, input: AddCartItemInput) {
  const created = db.transaction((tx) => {
    const variant = findPurchasableVariant(tx, input.variantId);

    const cartId =
      findActiveCartId(tx, userId) ??
      tx.insert(carts).values({ userId }).returning({ id: carts.id }).get().id;

    const existing = tx
      .select({ id: cartItems.id, quantity: cartItems.quantity })
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cartId), eq(cartItems.variantId, variant.id)))
      .get();

    const quantity = (existing?.quantity ?? 0) + input.quantity;
    assertQuantityAllowed(quantity, variant.stockQuantity);

    if (existing) {
      // Re-adding re-confirms the item at today's price, so refresh the snapshot.
      tx.update(cartItems)
        .set({ quantity, unitPriceSnapshot: variant.price })
        .where(eq(cartItems.id, existing.id))
        .run();
      return false;
    }

    tx.insert(cartItems)
      .values({ cartId, variantId: variant.id, quantity, unitPriceSnapshot: variant.price })
      .run();
    return true;
  });

  return { created, cart: await getCart(userId) };
}

// Changing quantity keeps the original price snapshot.
export async function updateItem(userId: number, itemId: number, input: UpdateCartItemInput) {
  db.transaction((tx) => {
    const item = findOwnedItem(tx, userId, itemId);
    const variant = findPurchasableVariant(tx, item.variantId);
    assertQuantityAllowed(input.quantity, variant.stockQuantity);

    tx.update(cartItems).set({ quantity: input.quantity }).where(eq(cartItems.id, item.id)).run();
  });

  return getCart(userId);
}

export async function removeItem(userId: number, itemId: number) {
  db.transaction((tx) => {
    const item = findOwnedItem(tx, userId, itemId);
    tx.delete(cartItems).where(eq(cartItems.id, item.id)).run();
  });

  return getCart(userId);
}
