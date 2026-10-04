# StoreForge API

A sample e-commerce backend built with Express.js, TypeScript, and SQLite (via Drizzle ORM) — designed to mirror patterns used by real e-commerce platforms (variant-based inventory, order/price snapshotting, refresh-token auth, payment/reservation lifecycles) while staying simple enough to run locally with a file-based database.

## Tech Stack

- **Node.js 26.x** (LTS)
- **Express 5.x**
- **TypeScript 6.x** — strict mode, ESM (`NodeNext`)
- **Drizzle ORM** + `better-sqlite3`
- **Zod** — request validation
- **JWT access tokens + opaque rotating refresh tokens** (`jsonwebtoken`, `argon2`)
- **Pino** — structured logging

## Getting Started

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` to real random values (each ≥32 characters — `openssl rand -hex 32` works well). The app fails fast at boot if these are missing or too short.

```bash
npm run db:generate   # generate a migration from src/db/schema.ts
npm run db:migrate    # apply it to the local SQLite file
npm run dev            # start the dev server (hot reload)
```

The API is served under `/api/v1`, with a plain health check at `GET /health`.

## Scripts

| Command               | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `npm run dev`         | Start the dev server with hot reload         |
| `npm run build`       | Compile TypeScript to `dist/`                |
| `npm start`           | Run the compiled server                      |
| `npm run db:generate` | Generate a Drizzle migration from the schema |
| `npm run db:migrate`  | Apply migrations to the SQLite file          |
| `npm run db:studio`   | Open Drizzle Studio to inspect data          |
| `npm test`            | Run tests (Vitest)                           |
| `npx tsc --noEmit`    | Type-check only                              |

## Project Structure

```
src/
  config/       env loading + validation (zod-parsed, fails fast on boot)
  db/           schema.ts (Drizzle tables + relations), index.ts (db client)
  middlewares/  auth, error handling, rate limiting, request validation
  modules/      one folder per resource: auth, products, categories, cart, orders, admin
  routes/       aggregates all module routers under /api/v1
  app.ts        Express app + global middleware
  server.ts     entry point
docs/
  DATABASE_SCHEMA.md   full table-by-table reference: columns, relations, calculated columns
  TIMESTAMP_RULES.md   createdAt/updatedAt invariants across every table
```

Pattern: `routes → controller (thin, HTTP only) → service (business logic, DB calls) → db`.

## Authentication

- Passwords hashed with **argon2id**.
- **Short-lived JWT access tokens** + **opaque, rotating refresh tokens** (stored hashed via SHA-256 in `refresh_tokens`, never the raw token) — this lets a session be revoked server-side (logout, suspected compromise), unlike a stateless JWT alone.
- `authenticate` + `authorize('admin')` middleware guard protected/admin-only routes.
- Rate limiting on `/auth/*` endpoints.

The `auth` module (`register`/`login`/`refresh`/`logout`) is fully wired to the database. `products`, `categories`, `cart`, `orders`, and `admin` currently return structured dummy JSON — each marked with a `// TODO: replace with real Drizzle queries` comment — ready to be wired in incrementally, following the `auth` module as the reference pattern.

## API Routes

All routes below are mounted under `/api/v1`, except the health check. `🔒` = requires a valid access token (`authenticate`). `🔒👤 admin` = requires an authenticated **admin** (`authenticate` + `authorize('admin')`).

| Method | Path                       | Auth       | Status | Description                                                                              |
| ------ | -------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------- |
| GET    | `/health`                  | —          | Live   | Basic liveness check (outside `/api/v1`)                                                 |
| POST   | `/auth/register`           | —          | Live   | Create an account, returns access token + sets refresh-token cookie                      |
| POST   | `/auth/login`              | —          | Live   | Authenticate, returns access token + sets refresh-token cookie                           |
| POST   | `/auth/refresh`            | —          | Live   | Rotate the refresh token (reads it from the httpOnly cookie), returns a new access token |
| POST   | `/auth/logout`             | —          | Live   | Revoke the current refresh token, clears the cookie                                      |
| GET    | `/products`                | —          | Dummy  | List products (pagination/filtering planned)                                             |
| GET    | `/products/:slug`          | —          | Dummy  | Get one product by slug                                                                  |
| GET    | `/categories`              | —          | Dummy  | List categories                                                                          |
| GET    | `/cart`                    | 🔒         | Dummy  | Get the current user's cart                                                              |
| POST   | `/cart/items`              | 🔒         | Dummy  | Add an item to the cart                                                                  |
| PATCH  | `/cart/items/:id`          | 🔒         | Dummy  | Update a cart item (e.g. quantity)                                                       |
| DELETE | `/cart/items/:id`          | 🔒         | Dummy  | Remove a cart item                                                                       |
| POST   | `/orders`                  | 🔒         | Dummy  | Checkout — create an order from the current cart                                         |
| GET    | `/orders`                  | 🔒         | Dummy  | List the current user's own orders                                                       |
| GET    | `/orders/:id`              | 🔒         | Dummy  | Get one of the current user's orders                                                     |
| POST   | `/orders/:id/cancel`       | 🔒         | Dummy  | Cancel an order                                                                          |
| POST   | `/admin/products`          | 🔒👤 admin | Dummy  | Create a product                                                                         |
| PATCH  | `/admin/products/:id`      | 🔒👤 admin | Dummy  | Update a product                                                                         |
| GET    | `/admin/orders`            | 🔒👤 admin | Dummy  | List all orders (any user)                                                               |
| PATCH  | `/admin/orders/:id/status` | 🔒👤 admin | Dummy  | Update an order's status                                                                 |

**Live** = fully wired to the database. **Dummy** = returns structured placeholder JSON today (each marked `// TODO: replace with real Drizzle queries` in code), with the correct auth/role middleware already in place so the shape won't change when real queries are wired in.

Admins intentionally have **no** route to view another customer's cart — that was a deliberate scope decision to keep the API simple for now (see `src/modules/cart/cart.routes.ts`).

## Data Model

13 tables across Identity, Catalog, Cart, Orders, and Reviews — see **`docs/DATABASE_SCHEMA.md`** for the full column-by-column reference, including every calculated/snapshot column and how it's derived (e.g. `cart_items.unitPriceSnapshot`, `orders.subtotal`/`total`, `order_items.productName`/`variantAttributes`, `payments.amount`).

Key design principles baked into the schema:

- **Price/catalog snapshotting** — cart and order line items freeze the product name, variant attributes, and price at the time of purchase, so historical orders never silently change if the catalog is edited later.
- **Variant-based inventory** — stock and pricing live on `product_variants` (a specific size/color/SKU), never on the parent `product`.
- **Guest + registered carts** — a cart belongs to exactly one of `userId` (registered) or `sessionId` (guest), never both.
- **Payment events are append-only** — a refund is always a new `payments` row, never an edit to the original `succeeded` row.
- **Inventory reservations** are short-lived holds created at checkout, with a `status` (`active`/`fulfilled`/`expired`) reflecting the underlying payment outcome, not deleted on resolution.

See **`docs/TIMESTAMP_RULES.md`** for the full set of cross-table date rules (e.g. `order.createdAt >= cart.createdAt`, `payment.createdAt` anchored to `order.createdAt` not `updatedAt`, status-specific gaps between `orders.createdAt` and `updatedAt`) — these aren't enforced by SQLite itself and need to be followed deliberately in any service/seed logic.

## Seed Data

A full, internally-consistent seed dataset has been generated for local development and demos, covering realistic volumes and relationships:

- 47 categories, 1,271 products, 3,568 product variants, product images
- 501 users (customer/admin), 1,012 addresses (Australia)
- Thousands of carts (registered + guest) and cart items
- 2,572 orders, order items, payments, and inventory reservations — all cross-validated against each other (price snapshots, status-to-payment consistency, timestamp ordering, etc.)
- 4,573 product reviews (one per user/product pair, from fulfilled orders only)

## Docker

Containerization is planned but not yet implemented in this repo.

## Contributing / AI-Assisted Development

See `CLAUDE.md` for conventions, patterns, and guardrails to follow when using Claude Code (or any AI coding assistant) on this project.
