# Timestamp Rules & Invariants

These rules aren't enforced by the SQLite schema itself (it has no way to express
cross-table date constraints) — they're domain knowledge that any seed script,
service layer, or future contributor needs to follow deliberately. Nothing here
is "figure-outable" from `schema.ts` alone.

## Tables with no `createdAt`/`updatedAt` at all

`addresses`, `categories`, `product_variants`, `product_images`, `cart_items`,
`order_items`, and `inventory_reservations` carry no timestamp columns. Don't
add them without a reason — they were deliberately left off these tables.

## users

- `createdAt` = account registration time.
- `updatedAt` = equal to `createdAt` at signup; only moves forward if the
  profile is later edited (name, email, etc.).

## refresh_tokens

- `createdAt` = token issue time (on login/refresh).
- No `updatedAt` — state changes are tracked via `revokedAt` instead
  (null while active, set once on logout/rotation).

## products

- `createdAt` must **predate every cart/order that ever contains it** — a
  product has to exist in the catalog before anyone can add it to a cart.
- `updatedAt` equal to `createdAt` unless the product listing is edited later
  (price change, description update, etc.).

## carts

- `createdAt` must be **≥ the owning user's `createdAt`** — a cart can't exist
  before its owner's account does. (Guest carts, with `userId: null`, have no
  such constraint since there's no account to be after.)
- No `updatedAt` column — a cart's `status` can change (`active` →
  `converted`/`abandoned`) without a tracked "last modified" time.

## orders

- `createdAt` must be **≥ the source cart's `createdAt`** — checkout happens
  at or shortly after the cart exists, never before.
- `updatedAt` rule depends on `status`:
  - `pending` → `updatedAt` **equals** `createdAt`. Nothing has happened to
    the order since it was created, so there's nothing to timestamp as a
    later change.
  - `paid` / `fulfilled` / `cancelled` / `refunded` → `updatedAt` must be
    **same day or at least 1 full day after** `createdAt`. Reaching any of these statuses
    means a real transition occurred afterward (payment cleared, warehouse
    processed it, etc.) — it can't happen the same instant the order was
    created.
  - Edge case: if an order was created too recently for a full day to have
    passed before "now," it **must stay `pending`** rather than being forced
    into a later status with a fabricated future `updatedAt`.

## payments

- `createdAt` is anchored to **`orders.createdAt`, not `orders.updatedAt`** —
  a payment attempt is triggered by checkout itself, which happens right
  around order creation. `orders.updatedAt` reflects _order-lifecycle_ delay
  (fulfillment taking time), which has nothing to do with _when the charge
  was attempted_.
- No `updatedAt` column. A payment row's own `status` resolves exactly once
  (`pending` → `succeeded` or `failed`) — there's no second timestamp for
  that resolution, only the one `createdAt` the row was written with.
- **A refund is a new row, not an update** — so when an order has both a
  `succeeded` and a `refunded` payment, the `refunded` row's `createdAt` must
  be **after** the `succeeded` row's `createdAt`. You can't refund money
  before collecting it.
- A `succeeded` or later payment's `createdAt` should land **before** its
  order's `updatedAt` when that order is `paid`/`fulfilled` — the payment
  succeeding is the _cause_ of the status flip, so it has to come first
  chronologically.

## reviews

- `createdAt` is **not** anchored to the order's `createdAt` — it's anchored
  to the relevant order's **`updatedAt`** (which, for a `fulfilled` order,
  approximates delivery time), plus a **2–30 day delay** on top, since real
  reviews trickle in after someone has actually received and used the
  product, not the instant the order updates.
- Reviews are **only generated from `fulfilled` orders** — you can't
  meaningfully review a `pending`, `paid`-not-yet-fulfilled, `cancelled`, or
  `refunded` order (nothing was received, or it was sent back).
- If a user bought the same product across **multiple fulfilled orders**, the
  review anchors to the **latest** one, not the first.
- Only one review per `(userId, productId)` pair — never more than one,
  regardless of how many times that pair was purchased.

## Orders reflect real-world use cases

The `createdAt` and `updatedAt` reflect how orders in real-world ecommerce companies work. The difference `createdAt` and `updatedAt` should not be more than 15 days.

- `pending` -> `paid` - the difference should be few hours.
- `paid` -> `fulfilled` - the difference should be 1 to 10 days.
- `pending` / `paid` -> `cancelled` - the difference should be few hours to 2 weeks. Cancellation almost always happen before shipping.
- `paid` -> `refunded` - the difference should be few days to couple of months. Most return / refund policies are 14 days to 90 days.

## Rule for `updatedAt` when updating orders.status

`paid` -> `createdAt` + 1–5 days
`fulfilled` -> `createdAt` + 2–14 days
`cancelled` -> `createdAt` + 1–14 days
`refunded` -> `createdAt` + 3–60 days

## Quick-reference ordering

```
user.createdAt
    ≤ cart.createdAt
        ≤ order.createdAt
            ≤ payment(succeeded).createdAt
                ≤ payment(refunded).createdAt   (if a refund exists)
            ≤ order.updatedAt                    (if status != pending)
                ≤ review.createdAt               (anchor + 2-30 days, fulfilled orders only)

product.createdAt < (every cart/order that references it)
```

## IMPORTANT

- The api should not send createdAt, for POST request, when inserting row for table that has createdAt column.
- The api should send updatedAt when updating, for PUT or PATCH requests, row for table that updatedAt column.
