## How `inventory_reservations` gets populated?

A row is created at the start of checkout not when an item is added to cart. This table guarantees that the stock is available when the checkout process is going on. Every reservation has `expiresdAt` data which is

On checkout, the system will first check for the stock availability. Use the below logic to check this

- using `orderId` find the `orderItems` (where `inventoryReservations.orderId` === `orderItems.orderId`).
- using `orderItems.variantId` find the stock of the products (`orderItems.variantId` === `productVariants.id`).
- calculate the stock availability
  `productVariants.stockQuantity` - SUM(active reservations for that variant) >= requested quantity?
- is the stock available?
  - if NO, stop. No order, no orderItems and no reservations. Return "Out of Stock" to the customer.
  - if YES, create order, create orderItems and create reservations.

**IMPORTANT:**

- Creating order, orderItems and reservations should possess atomicity.
- When the checkout process is completed and payment is successfull the reservation should be released and the status should change to `fulfilled`.
