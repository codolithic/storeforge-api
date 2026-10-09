# StoreForge API

A sample e-commerce backend built with Express.js, TypeScript, and SQLite (via Drizzle ORM) — designed to mirror patterns used by real e-commerce platforms (variant-based inventory, order/price snapshotting, inventory reservations, refresh-token rotation, payment lifecycles) while staying simple enough to run locally with a file-based database.

## Tech Stack

- **Node.js** `>=24` (developed on v26), ESM only
- **Express 5.2** — with `helmet`, `cors`, `cookie-parser`, `express-rate-limit`
- **TypeScript 7.0** — `strict` + `noUncheckedIndexedAccess`, `module: NodeNext`
- **Drizzle ORM 0.45** + `better-sqlite3`
- **Zod 4** — request validation
- **JWT access tokens + opaque rotating refresh tokens** (`jsonwebtoken`, `argon2`)
- **zod-openapi** + **Scalar** — OpenAPI 3.1 spec and interactive API reference
- **Vitest 5** + **supertest** — route-level tests

## Getting Started

```bash
npm install
```

Create a `.env` file (there is no `.env.example` yet) with at least:

```
JWT_ACCESS_SECRET=<32+ chars>   # openssl rand -hex 32
JWT_REFRESH_SECRET=<32+ chars>
```

The app fails fast at boot if either secret is missing or shorter than 32 characters. Optional variables, with their defaults:

| Variable                 | Default         | Notes                                                          |
| ------------------------ | --------------- | -------------------------------------------------------------- |
| `NODE_ENV`               | `development`   | `development` / `production` / `test`                          |
| `PORT`                   | `3000`          |                                                                |
| `DATABASE_URL`           | `./data/dev.db` | Path to the SQLite file                                        |
| `ACCESS_TOKEN_TTL`       | `15m`           | Access-token lifetime                                          |
| `REFRESH_TOKEN_TTL_DAYS` | `30`            | Refresh-token lifetime                                         |
| `ENABLE_API_DOCS`        | _(unset)_       | `true`/`false`; unset means docs are on except in `production` |

Then set up the database and start the server:

```bash
npm run db:migrate    # apply the committed migrations in drizzle/ to the SQLite file
npm run db:seed       # optional: load data/*.json (see "Seed Data" below)
npm run dev           # start the dev server (hot reload)
```

The API is served under **`/api`** (e.g. `/api/products`, `/api/auth/login`), with a plain health check at `GET /health`.

## API Docs

- `GET /api/docs` — Scalar interactive API reference
- `GET /api/docs/openapi.json` — OpenAPI 3.1 spec

The spec is generated at startup from each module's `*.openapi.ts`, which reuses the module's real Zod request validators. Response schemas are type-checked against the service return types, so drift fails `npm run typecheck`, and `tests/docs.test.ts` fails if the documented operations don't match the mounted routes. `npm run docs:lint` runs `redocly lint` on the generated spec.

A Postman collection is also available in `postman/postman_collection.json`.

## Scripts

| Command               | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `npm run dev`         | Start the dev server with hot reload                  |
| `npm run build`       | Compile TypeScript to `dist/`                         |
| `npm start`           | Run the compiled server                               |
| `npm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts`  |
| `npm run db:migrate`  | Apply migrations to the SQLite file                   |
| `npm run db:studio`   | Open Drizzle Studio to inspect data                   |
| `npm run db:seed`     | Load all `data/*.json` into the database (idempotent) |
| `npm test`            | Run the test suite (Vitest)                           |
| `npm run typecheck`   | Type-check `src/` and `tests/`                        |
| `npm run docs:lint`   | Build the OpenAPI spec and lint it with Redocly       |
| `npm run format`      | Format all files with Prettier                        |

## Project Structure

```
src/
  config/       env loading + validation (zod-parsed, fails fast on boot)
  db/           schema.ts (Drizzle tables + relations), index.ts (db client), seed-*.ts
  docs/         OpenAPI document builder + /api/docs router (Scalar UI + openapi.json)
  middlewares/  auth, error handling, rate limiting, request validation
  modules/      one folder per resource: auth, products, categories, cart, orders,
                payments, reviews, admin
  routes/       aggregates all module routers, mounted under /api
  utils/        apiResponse, jwt, password
  app.ts        Express app + global middleware + /health
  server.ts     entry point
drizzle/        committed SQL migrations
scripts/        dev scripts (e.g. lint-openapi.ts)
tests/          route-level Vitest + supertest tests, fixtures, and helpers
postman/        Postman collection
```

Each module follows the same file layout — `<module>.routes.ts`, `.controller.ts`, `.service.ts`, `.types.ts` (Zod schemas), and `.openapi.ts` — and the request pipeline is `routes → controller (thin, HTTP only) → service (business logic, Drizzle) → db`.

## Authentication

- Passwords hashed with **argon2**.
- **Short-lived JWT access tokens** (payload `{ sub, role }`, sent as a Bearer token) + **opaque, rotating refresh tokens** stored SHA-256 hashed in `refresh_tokens` — never the raw token.
- The refresh token travels in an **httpOnly `refresh_token` cookie** (`sameSite: 'strict'`, `secure` in production), not in the JSON body.
- Every refresh rotates the token atomically. **Reuse detection:** presenting an already-revoked token revokes all of that user's sessions.
- Login returns the same error (and similar timing) for unknown emails and wrong passwords.
- `authenticate` + `authorize('admin')` middleware guard protected/admin-only routes.
- `/auth/register` and `/auth/login` are rate-limited (10 requests per 15 minutes).

## API Routes

All routes below are mounted under `/api`, except the health check. `🔒` = requires a valid access token. `🔒👤 admin` = requires an authenticated **admin**. Other users' carts, orders, payments, and reviews return 404.

| Method | Path                       | Auth       | Description                                                                                                        |
| ------ | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/health`                  | —          | Liveness check (outside `/api`)                                                                                    |
| POST   | `/auth/register`           | —          | Create an account; returns an access token and sets the refresh-token cookie                                       |
| POST   | `/auth/login`              | —          | Log in; returns an access token and sets the refresh-token cookie                                                  |
| POST   | `/auth/refresh`            | —          | Rotate the refresh token (from the cookie) and return a new access token                                           |
| POST   | `/auth/logout`             | —          | Revoke the current refresh token and clear the cookie                                                              |
| GET    | `/products`                | —          | List active products (pagination, category, search, price range, rating range, sort)                               |
| GET    | `/products/:slug`          | —          | Get an active product with its category, images, and variants (`inStock` flag)                                     |
| GET    | `/categories`              | —          | Two-level category menu                                                                                            |
| GET    | `/cart`                    | 🔒         | Get the current user's active cart                                                                                 |
| POST   | `/cart/items`              | 🔒         | Add a variant to the cart (merges into an existing line)                                                           |
| PATCH  | `/cart/items/:id`          | 🔒         | Update a cart line's quantity                                                                                      |
| DELETE | `/cart/items/:id`          | 🔒         | Remove a cart line                                                                                                 |
| POST   | `/orders`                  | 🔒         | Checkout: create an order from the active cart and charge the mock payment gateway                                 |
| GET    | `/orders`                  | 🔒         | List the current user's orders (paginated, `status` filter)                                                        |
| GET    | `/orders/:id`              | 🔒         | Get one of the current user's orders                                                                               |
| POST   | `/orders/:id/cancel`       | 🔒         | Cancel a `pending` order                                                                                           |
| GET    | `/payments`                | 🔒         | List the current user's payments (paginated, `orderId`/`status` filters)                                           |
| GET    | `/payments/:id`            | 🔒         | Get one of the current user's payments                                                                             |
| POST   | `/payments/:id/refund`     | 🔒👤 admin | Fully refund a payment (new `refunded` payment row; order → `refunded`)                                            |
| GET    | `/reviews`                 | —          | List reviews for a product (`productId` required, `rating` filter, newest first)                                   |
| GET    | `/reviews/me`              | 🔒         | List the current user's reviews                                                                                    |
| POST   | `/reviews`                 | 🔒         | Review a product from a `fulfilled` order (one review per user per product)                                        |
| PATCH  | `/reviews/:id`             | 🔒         | Update your own review                                                                                             |
| DELETE | `/reviews/:id`             | 🔒         | Delete a review (author or admin)                                                                                  |
| POST   | `/admin/products`          | 🔒👤 admin | Create a product with optional variants and images (defaults to `draft`)                                           |
| PATCH  | `/admin/products/:id`      | 🔒👤 admin | Update product-level fields                                                                                        |
| GET    | `/admin/orders`            | 🔒👤 admin | List all orders (paginated, `status`/`userId` filters)                                                             |
| PATCH  | `/admin/orders/:id/status` | 🔒👤 admin | Change an order's status (`paid → fulfilled` or `pending → cancelled` only; paid orders are refunded via payments) |

### Responses

Every response uses a shared envelope: `{ "success": true, "data": ... }` on success and `{ "success": false, "error": { "code", "message" } }` on failure (validation errors add per-field `details`). Paginated lists return `{ items, pagination: { page, limit, total, totalPages } }`.

### Checkout and the mock payment gateway

There is no real payment provider. `POST /orders` accepts an optional `paymentToken` that controls the simulated outcome:

| `paymentToken`          | Result                                                                           |
| ----------------------- | -------------------------------------------------------------------------------- |
| omitted / anything else | Payment `succeeded`, order `paid`, stock decremented → `201`                     |
| `tok_decline`           | Payment `failed`, order `cancelled`, cart reopened → `402 PAYMENT_DECLINED`      |
| `tok_gateway_error`     | Payment `failed`, order `cancelled`, cart reopened → `502 PAYMENT_GATEWAY_ERROR` |

During checkout, prices and product details are snapshotted into `order_items` and stock is held with 15-minute `inventory_reservations`, which are marked `fulfilled` or `expired` once the payment settles.

## Data Model

13 tables across Identity, Catalog, Cart, Orders/Payments, and Reviews, defined in `src/db/schema.ts`. Key design principles:

- **Variant-based inventory** — price and stock live on `product_variants` (a specific size/color/SKU), never on the parent product; `products.basePrice` is a display price only.
- **Price/catalog snapshotting** — cart and order lines freeze the product name, variant attributes, and price, so historical orders never change when the catalog is edited.
- **Guest + registered carts** — a cart belongs to a `userId` or a guest `sessionId` (the guest path is modelled but not yet wired up).
- **Payment-driven order status** — `pending → paid → fulfilled`, `pending → cancelled`, or `paid → refunded`. Refunds are a new `payments` row, never an edit to the original `succeeded` row.
- **Inventory reservations** are short-lived holds created at checkout, resolved to `fulfilled`/`expired` rather than deleted.
- **Conventions** — timestamps are ISO-8601 `text`, money is `real`.

## Testing

```bash
npm test                                         # run everything
npx vitest run tests/products.test.ts            # one file
npx vitest run -t "treats % as a literal character"  # one case
```

Tests live in `tests/`, one file per resource, and drive the real Express app over HTTP with supertest. Each file gets its own fresh in-memory SQLite database built from the committed migrations and seeded with small fixtures from `tests/fixtures/`.

## Seed Data

`npm run db:seed` loads a full, internally consistent dataset from `data/*.json` (gitignored, so not available on a fresh clone):

- 47 categories, 1,271 products, 3,568 product variants, product images
- 501 users (customer/admin), 1,012 addresses (Australia)
- Thousands of carts (registered + guest) and cart items
- 2,572 orders, order items, payments, and inventory reservations — cross-validated against each other (price snapshots, status-to-payment consistency, timestamp ordering)
- 4,573 product reviews (one per user/product pair, from fulfilled orders only)

## Docker

Containerization is planned but not yet implemented in this repo.

## Contributing / AI-Assisted Development

See `.claude/CLAUDE.md` for conventions, patterns, and guardrails to follow when using Claude Code (or any AI coding assistant) on this project.
