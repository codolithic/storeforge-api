## Order and Payment Status flow

The payment status drives order status. The payments table will have 1 or more rows depending on the flow of order status.

- When the order is created it will be in `pending` status and a payment will also be created in `pending` status.
- When the payment moves to `succeeded` the order status will be `paid`.
- When the order is shipped / delivered the status of order will move to `fulfilled`. The shipping or delivery is not part of the app, it has to be done manually by the `admin` users.
- When the payment is `failed` the order status will be `cancelled`.
- When the payment moves from `pending` to `succeeded` the order status will be `paid`.
- When the order is `cancelled` / `refunded` after it is `paid` then there will be new payment row with status `refunded`. In this case, there will be 2 payments rows for the given order - one for the `paid` order status and other one for `cancelled` / `refunded` status.
- When the `paid` order is updated to `cancelled` / `refunded` there will be new payment with status `cancelled` / `refunded`.
