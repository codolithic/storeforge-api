import { z } from 'zod';

export const PAYMENT_PROVIDERS = ['stripe', 'paypal'] as const;

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

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
