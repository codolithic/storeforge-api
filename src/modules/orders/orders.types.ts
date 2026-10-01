import { z } from 'zod';

// How long checkout holds stock for a pending order before the hold lapses.
export const RESERVATION_TTL_MINUTES = 15;

// The body is optional: express.json() leaves req.body undefined for an empty POST.
export const checkoutSchema = z
  .object({
    shippingAddressId: z.number().int().positive().optional(),
  })
  .default({});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'paid', 'fulfilled', 'cancelled', 'refunded']).optional(),
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const orderParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type OrderParams = z.infer<typeof orderParamsSchema>;
