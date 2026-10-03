import { z } from 'zod';

export const PAYMENT_PROVIDERS = ['stripe', 'paypal'] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

// `paymentToken` stands in for the card/wallet token a client SDK would hand
// back (e.g. Stripe's `tok_...`); the simulated gateway decides the outcome from it.
export const createPaymentSchema = z.object({
  orderId: z.number().int().positive(),
  provider: z.enum(PAYMENT_PROVIDERS),
  paymentToken: z.string().trim().min(1).max(255),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const listPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  orderId: z.coerce.number().int().positive().optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;

export const paymentParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type PaymentParams = z.infer<typeof paymentParamsSchema>;
