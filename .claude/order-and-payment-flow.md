## Order and Payment Status flow

The payment status drives order status. The payments table will have 1 or more rows depending on the flow of order status.

- When the order is created it will be in `pending` status and a payment will also be created in `pending` status.
- When the payment moves to `succeeded` the order status will be `paid`.
- When the order is shipped / delivered the `orders.status` will move to `fulfilled`. The shipping or delivery is not part of the app, the `admin` users will do it manually either using api or db statement.
- When the payment is `failed` the order status will be `cancelled`.
- When the payment moves from `pending` to `succeeded` the order status will be `paid`.
- When the order is `cancelled` / `refunded` after it is `paid` then there will be new payment row with status `refunded`. In this case, there will be 2 payments rows for the given order - one for the `paid` order status and other one for `cancelled` / `refunded` status.
- When the `paid` order is updated to `cancelled` / `refunded` there will be new payment with status `cancelled` / `refunded`.
- For succeeded `payments` (`pending` to `succeeded`) the `status` for same `payment` row will be updated to `succeeded` - no new payment.

## Summary of order flow

| Order path                 | Payment rows | Final payment statuses |
| -------------------------- | ------------ | ---------------------- |
| pending → paid → fulfilled | 1            | succeeded              |
| pending → cancelled        | 1            | cancelled              |
| pending → paid → cancelled | 2            | succeeded, refunded    |
| pending → paid → refunded  | 2            | succeeded, refunded    |

## Checkout flow for orders

**`POST /orders`:**

### Example of payment provider mock

```ts
// src/services/payment-provider.ts
export interface ChargeResult {
  success: boolean;
  providerRef: string;
}

export interface PaymentProvider {
  charge(params: { orderId: number; amount: number }): Promise<ChargeResult>;
}

// src/services/mock-payment-provider.ts
import crypto from 'node:crypto';
import type { PaymentProvider } from './payment-provider.js';

export class MockPaymentProvider implements PaymentProvider {
  async charge({ orderId, amount }: { orderId: number; amount: number }) {
    const providerRef = `mock_${crypto.randomBytes(12).toString('hex')}`;
    // deterministic, controllable outcome — see below
    const success = true || false; // See below to decide whether to fail the payment.
    return { success, providerRef };
  }
}
```

### When to fail the payments

A magic trigger in the request — e.g. checkout accepts an optional paymentToken, and 'tok_decline' always fails, anything else (or omitted) always succeeds.

### Steps

1. Validate stock, create order (pending), order_items, reservations (active)
2. Create payment row (pending)
3. Call paymentProvider.charge() — mock responds immediately
4. Update payment.status → succeeded/failed
5. If succeeded: order.status → paid, reservations → fulfilled
   If failed: order.status stays pending (or → cancelled, your call), reservations → expired
6. Return the final order state in one response
