# StoreForge Database Schema

SQLite database (via Drizzle ORM). 13 tables across Identity, Catalog, Cart, Orders, and Reviews.

## users

| Column                | Purpose                                      |
| --------------------- | -------------------------------------------- |
| id                    | Primary key                                  |
| email                 | Unique login identifier                      |
| passwordHash          | argon2id hash — never the plaintext password |
| firstName / lastName  | Display name                                 |
| role                  | `customer` or `admin`                        |
| createdAt / updatedAt | Account creation / last profile update       |

**Relations:** has many `addresses`, `orders`, `refreshTokens`, `reviews`.

## refresh_tokens

| Column    | Purpose                                                           |
| --------- | ----------------------------------------------------------------- |
| id        | Primary key                                                       |
| userId    | Owner of the session                                              |
| tokenHash | SHA-256 hash of the opaque refresh token — raw token never stored |
| expiresAt | When the token stops being valid                                  |
| revokedAt | Set on logout or rotation; null while active                      |
| createdAt | Token issue time                                                  |

**Relations:** belongs to `users` (cascade delete).
**Why opaque + hashed:** unlike a stateless JWT, this can be revoked server-side (logout, suspected theft) and rotated on every refresh.

## addresses

| Column                              | Purpose                                      |
| ----------------------------------- | -------------------------------------------- |
| id                                  | Primary key                                  |
| userId                              | Owner                                        |
| line1 / line2                       | Street address, line2 optional (unit/apt)    |
| city / state / postalCode / country | Location fields                              |
| isDefault                           | Marks the one address pre-filled at checkout |

**Relations:** belongs to `users` (cascade delete); referenced by `orders.shippingAddressId`.

## categories

| Column      | Purpose                                                               |
| ----------- | --------------------------------------------------------------------- |
| id          | Primary key                                                           |
| name / slug | Display name and URL-safe identifier                                  |
| parentId    | Self-reference — enables nested categories (e.g. Electronics → Audio) |

**Relations:** self-referencing parent/child; has many `products`.

## products

| Column                    | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| id                        | Primary key                                                          |
| name / slug / description | Catalog display content                                              |
| basePrice                 | Reference/display price on listing pages — **not** the charged price |
| categoryId                | Which category this belongs to                                       |
| status                    | `active`, `draft`, or `archived`                                     |
| createdAt / updatedAt     | Catalog lifecycle timestamps                                         |

**Relations:** belongs to `categories`; has many `productVariants`, `productImages`, `reviews`.

## product_variants

| Column        | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| id            | Primary key                                                              |
| productId     | Parent product                                                           |
| sku           | Unique stock-keeping unit code                                           |
| price         | **Actual sellable price** for this size/color/config — what gets charged |
| attributes    | JSON, e.g. `{ "color": "Black", "size": "M" }`                           |
| stockQuantity | Units available; 0 = out of stock                                        |

**Relations:** belongs to `products`; referenced by `cartItems`, `orderItems`, `inventoryReservations`.
**Why separate from products.basePrice:** different variants of the same product legitimately cost different amounts (e.g. storage tier, hardcover vs. paperback).

## product_images

| Column    | Purpose                                  |
| --------- | ---------------------------------------- |
| id        | Primary key                              |
| productId | Which product this image belongs to      |
| url       | Image location                           |
| position  | Display order; `0` = primary/cover image |

**Relations:** belongs to `products` (cascade delete).

## carts

| Column    | Purpose                                                          |
| --------- | ---------------------------------------------------------------- |
| id        | Primary key                                                      |
| userId    | Set for a logged-in customer's cart; null for guests             |
| sessionId | Set for a guest cart (no account yet); null once owned by a user |
| status    | `active`, `converted` (became an order), or `abandoned`          |
| createdAt | Cart creation time                                               |

**Relations:** belongs to `users` (nullable); has many `cartItems`.
**Rule:** exactly one of `userId`/`sessionId` is set, never both.

## cart_items

| Column            | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| id                | Primary key                                                |
| cartId            | Parent cart                                                |
| variantId         | Which exact variant was added                              |
| quantity          | How many units                                             |
| unitPriceSnapshot | Variant's price **at the moment it was added to the cart** |

**Relations:** belongs to `carts` (cascade delete) and `productVariants`.
**Calculated/snapshot column:** `unitPriceSnapshot` is copied from `productVariants.price` once, when the item is added, and does **not** update if the live variant price later changes — it reflects "price when added," not current catalog price.

## orders

| Column                | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| id                    | Primary key                                                 |
| userId                | Who placed the order (customers only, by application logic) |
| status                | `pending`, `paid`, `fulfilled`, `cancelled`, `refunded`     |
| subtotal              | Cost of goods only, pre-tax/shipping                        |
| tax                   | Tax amount for this order                                   |
| shippingFee           | Delivery cost for this order                                |
| total                 | Final charged amount                                        |
| shippingAddressId     | Snapshot reference to the `addresses` row used for delivery |
| createdAt / updatedAt | Order placed / last status change                           |

**Relations:** belongs to `users` and `addresses`; has many `orderItems`, `payments`.
**Calculated columns:**

- `subtotal` = Σ (`orderItems.unitPrice × orderItems.quantity`) — computed once at checkout from the cart's items, then frozen.
- `total` = `subtotal + tax + shippingFee` — also frozen at checkout; never recomputed later.

## order_items

| Column            | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| id                | Primary key                                                                          |
| orderId           | Parent order                                                                         |
| variantId         | Which variant was purchased                                                          |
| productName       | Product name **at time of purchase** (plain text, cheap to read/search)              |
| variantAttributes | JSON snapshot of the variant's options at purchase time                              |
| unitPrice         | Price actually paid per unit — copied from `cartItems.unitPriceSnapshot` at checkout |
| quantity          | Units purchased — copied from `cartItems.quantity`                                   |

**Relations:** belongs to `orders` (cascade delete) and `productVariants`.
**Calculated/snapshot columns:** `productName` and `variantAttributes` are resolved once via `variantId → productVariants.productId → products.name` (plus the variant's own `attributes`) and written permanently, so historical orders stay accurate even if the catalog later changes.

## payments

| Column      | Purpose                                            |
| ----------- | -------------------------------------------------- |
| id          | Primary key                                        |
| orderId     | Which order this payment event belongs to          |
| provider    | Payment gateway name (e.g. "stripe")               |
| providerRef | The gateway's own transaction/charge ID            |
| status      | `pending`, `succeeded`, `failed`, `refunded`       |
| amount      | Amount charged or refunded in **this** transaction |
| createdAt   | When the payment attempt was made                  |

**Relations:** belongs to `orders` (cascade delete); one order can have multiple payment rows (initial charge, retries, partial refunds).
**Calculated column:** `amount` should equal `orders.total` for a standard full payment (set once, when the charge is created). A partial refund is a **separate row**, not an edit to this one.
**Rule:"** a `pending` payment will either move to `succeeded` or `failed` and cannot be updated to `refunded`. A `succeeded` or `failed` payment can have a `refunded` transaction but that will be new payment.

## inventory_reservations

| Column    | Purpose                                                              |
| --------- | -------------------------------------------------------------------- |
| id        | Primary key                                                          |
| variantId | Which variant has stock held                                         |
| orderId   | Order the hold is for (nullable — held before an order fully exists) |
| quantity  | Units reserved                                                       |
| expiresAt | When the hold auto-releases if checkout isn't completed              |

**Relations:** belongs to `productVariants` and optionally `orders`.
**Purpose:** short-lived stock lock between "checkout started" and "payment confirmed," preventing overselling the same unit.

## reviews

| Column    | Purpose                |
| --------- | ---------------------- |
| id        | Primary key            |
| productId | Product being reviewed |
| userId    | Reviewer               |
| rating    | Numeric score          |
| comment   | Free-text review       |
| createdAt | Submission time        |

**Relations:** belongs to `products` (cascade delete) and `users` (cascade delete).
**Rule:** the review can be only for the `fulfilled` orders and not `pending`, `paid`, `cancelled` or `refunded`.
