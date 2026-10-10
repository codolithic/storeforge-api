# Timestamp Rules & Invariants

These rules aren't enforced by the SQLite schema itself (it has no way to express
cross-table date constraints) — they're domain knowledge that any seed script,
service layer, or future contributor needs to follow deliberately. Nothing here
is "figure-outable" from `schema.ts` alone.

The rules come in two kinds:

- **Ordering invariants** (e.g. `order.createdAt ≥ cart.createdAt`) hold for every
  row, whether it was seeded or written by the API.
- **Seed-data gaps** (e.g. `paid` is 1–5 days after `createdAt`, reviews arrive
  2–30 days after delivery) make the historical seed data look realistic. The API
  doesn't fake these: it stamps the real time of each write, so an order checked
  out through `POST /orders` goes `pending → paid` within the same request.

## Format and who sets what

- `createdAt` / `updatedAt` default to SQLite `current_timestamp`, which stores
  **UTC as `YYYY-MM-DD HH:MM:SS`** (space separator, no `T`/`Z`, second precision).
- On insert, the API **never sets `createdAt` (or `updatedAt`)** — it leaves both to
  the column defaults.
- On any update that changes a row in a table with an `updatedAt` column, the API
  **sets `updatedAt` to `sql\`(current_timestamp)\``** in the same `UPDATE`. Use the
SQL expression, not a JS date, so the format matches the default. This applies to
every write path, not only `PATCH`/`PUT` routes — e.g. checkout (`POST /orders`),
cancel (`POST /orders/:id/cancel`), and refund (`POST /payments/:id/refund`) all
bump `orders.updatedAt`.
- Expiry/revocation columns (`refresh_tokens.expiresAt`/`revokedAt`,
  `inventory_reservations.expiresAt`) are computed in JS and written with
  `toISOString()` (`YYYY-MM-DDTHH:MM:SS.sssZ`). They're compared as strings against
  `new Date().toISOString()`, so values written by the API must stay in ISO format.

## Tables with no `createdAt`/`updatedAt`

`addresses`, `categories`, `product_variants`, `product_images`, `cart_items`,
`order_items`, and `inventory_reservations` carry no `createdAt`/`updatedAt`
columns. Don't add them without a reason — they were deliberately left off these
tables. (`inventory_reservations` does have `expiresAt`; see the inventory
reservation guide.)

## users

- `createdAt` = account registration time.
- `updatedAt` = equal to `createdAt` at signup; only moves forward if the
  profile is later edited (name, email, etc.). There is no profile-edit route yet.

## refresh_tokens

- `createdAt` = token issue time (on register/login/refresh).
- `expiresAt` = issue time + `REFRESH_TOKEN_TTL_DAYS`.
- No `updatedAt` — state changes are tracked via `revokedAt` instead
  (null while active, set once on logout, rotation, or reuse detection).

## products

- `createdAt` must **predate every cart/order that ever contains it** — a
  product has to exist in the catalog before anyone can add it to a cart.
- `updatedAt` equal to `createdAt` unless the product listing is edited later
  (`PATCH /admin/products/:id` bumps it). Variant price/stock changes live on
  `product_variants`, which has no timestamp, so they don't touch it.

## carts

- `createdAt` must be **≥ the owning user's `createdAt`** — a cart can't exist
  before its owner's account does. (Guest carts, with `userId: null`, have no
  such constraint since there's no account to be after.)
- No `updatedAt` column — a cart's `status` can change (`active` →
  `converted`/`abandoned`, or back to `active` when a failed checkout reopens it)
  without a tracked "last modified" time.

## orders

- `createdAt` must be **≥ the source cart's `createdAt`** — checkout happens
  at or shortly after the cart exists, never before.
- `updatedAt` **equals** `createdAt` while the order is `pending`, and is
  **≥ `createdAt`** once it has moved to `paid` / `fulfilled` / `cancelled` /
  `refunded`.
- Through the API, `updatedAt` is the time of the last status change: checkout
  sets `paid` (or `cancelled` on a failed payment) seconds after `createdAt`, and
  later admin/refund actions bump it again.

### Seed data: realistic gaps between `createdAt` and `updatedAt`

Seeded orders mimic real e-commerce timing. The gap between `createdAt` and
`updatedAt` should not be more than 15 days, except refunds (below).

| Status      | `updatedAt`             | Why                                                |
| ----------- | ----------------------- | -------------------------------------------------- |
| `paid`      | `createdAt` + 1–5 days  | Payment clears after checkout                      |
| `fulfilled` | `createdAt` + 2–14 days | Shipping takes 1–10 days after payment             |
| `cancelled` | `createdAt` + 1–14 days | Cancellation almost always happens before shipping |
| `refunded`  | `createdAt` + 3–60 days | Most return/refund policies allow 14–90 days       |

- If a seeded order was created too recently for its status's minimum gap to
  have passed before "now," it **must stay `pending`** rather than being forced
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
- A `succeeded` payment's `createdAt` must be **≤ its order's `updatedAt`** when
  that order is `paid`/`fulfilled` — the payment succeeding is the _cause_ of the
  status flip, so it comes first. Through the API both can fall in the same
  second, so they may be equal.

## reviews

- No `updatedAt` column — editing a review (`PATCH /reviews/:id`) doesn't record
  a timestamp.
- Reviews can only exist for **`fulfilled` orders** — you can't meaningfully
  review a `pending`, `paid`-not-yet-fulfilled, `cancelled`, or `refunded` order
  (nothing was received, or it was sent back). The API enforces this, so a
  review's `createdAt` is always ≥ that order's `updatedAt`.
- Only one review per `(userId, productId)` pair — never more than one,
  regardless of how many times that pair was purchased.

### Seed data: review delay

- `createdAt` is **not** anchored to the order's `createdAt` — it's anchored
  to the relevant order's **`updatedAt`** (which, for a `fulfilled` order,
  approximates delivery time), plus a **2–30 day delay** on top, since real
  reviews trickle in after someone has actually received and used the
  product, not the instant the order updates.
- If a user bought the same product across **multiple fulfilled orders**, the
  review anchors to the **latest** one, not the first.

## Quick-reference ordering

```
user.createdAt
    ≤ cart.createdAt
        ≤ order.createdAt
            ≤ payment(succeeded).createdAt
                ≤ payment(refunded).createdAt   (if a refund exists)
            ≤ order.updatedAt                    (if status != pending)
                ≤ review.createdAt               (fulfilled orders only; seed adds 2–30 days)

product.createdAt < (every cart/order that references it)
```
