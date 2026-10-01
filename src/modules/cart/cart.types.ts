import { z } from 'zod';

// Per-line cap; stock is checked separately in the service.
export const MAX_ITEM_QUANTITY = 99;

const quantity = z.number().int().min(1).max(MAX_ITEM_QUANTITY);

export const addCartItemSchema = z.object({
  variantId: z.number().int().positive(),
  quantity: quantity.default(1),
});

export type AddCartItemInput = z.infer<typeof addCartItemSchema>;

export const updateCartItemSchema = z.object({
  quantity,
});

export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;

export const cartItemParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CartItemParams = z.infer<typeof cartItemParamsSchema>;
