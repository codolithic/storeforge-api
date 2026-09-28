# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**StoreForge API** — a sample e-commerce backend built with Express.js, TypeScript, and SQLite (via Drizzle ORM). It follows patterns used by real e-commerce platforms (variant-level inventory, order snapshots, inventory reservations, refresh-token rotation) while staying simple enough to run locally with a file-based DB.

## Tech Stack

All dependencies were bumped to their latest stable releases on 2026-09-27; `npx tsc --noEmit`, `npm run build`, and a runtime smoke test pass on this set.

- Node.js `engines: >=24` (developed on v26), ESM only (`"type": "module"`)
- Express 5.2, with helmet 8.3, cors 2.8, cookie-parser 1.4, express-rate-limit 8.7
- TypeScript 7.0, `strict` + `noUncheckedIndexedAccess`, `module: NodeNext`
- Drizzle ORM 0.45 + drizzle-kit 0.31, on better-sqlite3 13
- Zod 4.6 for validation
- jsonwebtoken 9.0 (access tokens) + argon2 0.45 (password hashing)
- Pino 10 / pino-http 11 for request logging, dotenv 18 for env loading
- Vitest 5 + supertest 7.3 as the (as yet unused) test stack

## Commands

```bash
npm run dev          # start dev server with hot reload (tsx watch src/server.ts)
npm run build        # compile TypeScript to dist/
npm start            # run compiled server (node dist/server.js)
npm run db:generate  # generate a Drizzle migration from src/db/schema.ts
npm run db:migrate   # apply migrations to the SQLite file
npm run db:studio    # open Drizzle Studio to inspect data
npm run db:seed      # load data/categories.json into the categories table (idempotent)
npm run db:seed:products  # load data/products.json into products (run db:seed first)
npm test             # vitest run
npx tsc --noEmit     # type-check only
```

Always run `npx tsc --noEmit` after making changes before considering a task done — it is the only automated check in the repo. There is **no linter or formatter configured** (no ESLint/Prettier); match the surrounding style by hand.

### Tests

`vitest` 5 and `supertest` are installed, but **no test files exist yet** and there is no `vitest.config.ts`, so `npm test` currently exits 1 with "No test files found". When adding the first tests, run a single file or case with:

```bash
npx vitest run src/modules/auth/auth.service.test.ts
npx vitest run -t "rejects an expired refresh token"
```

Note that importing anything that reaches `src/config/env.ts` parses the environment at import time and throws if `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are missing — tests need those set.

## Architecture

Layered, feature-first structure:

```
src/
  config/env.ts       zod-parsed env, evaluated at import time, fails fast on boot
  db/schema.ts        all Drizzle tables + relations
  db/index.ts         better-sqlite3 client (WAL + foreign_keys ON), exports `db`
  middlewares/        auth, error, rateLimiter, validate
  modules/            one folder per resource: auth, products, categories, cart, orders, admin
  routes/index.ts     aggregates module routers, mounted at /api/v1 by app.ts
  utils/              apiResponse, jwt, password
  app.ts              express app + global middleware + /health
  server.ts           entry point (app.listen)
```

**Request pipeline:** `routes` → `controller` (HTTP only, thin) → `service` (business logic, Drizzle) → `db`.

**File naming inside a module is prefixed, not bare:** `auth.routes.ts`, `auth.controller.ts`, `auth.service.ts`, `auth.types.ts` — not `routes.ts`. Follow this when adding files.

Only `auth` has a full service layer wired to the DB. `products`, `categories`, `cart`, `orders`, and `admin` intentionally return **dummy JSON** marked with `// TODO: replace with real Drizzle queries` — this is expected and being filled in incrementally. `admin` has no controller at all; its dummy handlers are inline in `admin.routes.ts` and should be extracted into `admin.controller.ts` + `admin.service.ts` when implemented. Use the `auth` module as the reference pattern: `types.ts` (Zod schemas) → `service.ts` (logic) → `controller.ts` (calls the service) → `routes.ts` (wires middleware).

## Domain model (read before touching catalog/cart/order code)

- **Price and stock live on `product_variants`, never on `products`.** `products.basePrice` is a display/starting price only; `product_variants.price` and `product_variants.stockQuantity` are authoritative. `cart_items` and `order_items` reference `variantId`, not `productId`.
- **Never live-join order data to current product/price.** `order_items` snapshots `productNameSnapshot` and `unitPrice` at purchase time; `cart_items` snapshots `unitPriceSnapshot`. Preserve this when writing cart/order logic.
- **Carts support guests:** `carts.userId` is nullable and `carts.sessionId` identifies an anonymous cart. Current cart routes are all behind `authenticate`, so the guest path is modelled but not yet wired up.
- **`inventory_reservations`** are short-lived stock holds taken during checkout and released on failure/timeout — checkout logic should create them rather than decrementing `stockQuantity` directly.
- **Column types:** timestamps are `text` ISO-8601 strings defaulting to `current_timestamp`, and all money is `real` (SQLite float). Stay consistent with both rather than introducing a second convention.

## Auth flow

- Access token: short-lived JWT (`ACCESS_TOKEN_TTL`, default `15m`), payload `{ sub: userId, role }`, verified per-request with no DB hit.
- Refresh token: opaque `crypto.randomBytes(48)` hex string, **never a JWT**, SHA-256 hashed before storage in `refresh_tokens`. Never store or log the raw token.
- The refresh token travels in an **httpOnly `refresh_token` cookie** (`sameSite: 'strict'`, `secure` in production), set by `auth.controller.ts` — not in the JSON body. `/auth/refresh` and `/auth/logout` read it from `req.cookies`.
- Every use of a refresh token rotates it: the old row is marked `revokedAt` and a fresh pair is issued.
- Login returns an identical error for unknown-email and wrong-password; don't split them (it leaks which emails are registered).
- Don't extend access-token lifetime as a shortcut instead of using the refresh flow.

## Conventions

- All route handlers are `async`. Express 5 forwards rejected promises (and synchronous throws) to `errorHandler`, so **no manual try/catch or async wrapper** anywhere.
- Throw `ApiError(status, code, message)` (from `middlewares/error.middleware.ts`) for expected failures. `errorHandler` also maps `ZodError` → 400 `VALIDATION_ERROR` automatically. Prefer throwing `ApiError` over calling `sendError`; some dummy controllers still use `sendError` and should switch when they get real logic.
- Every response uses the shared envelope from `utils/apiResponse.ts` — `sendSuccess(res, data, status?)` → `{ success, data }`, errors → `{ success: false, error: { code, message } }`. Don't hand-roll response shapes.
- Validate request bodies with a Zod schema in the module's `*.types.ts`, applied via `validateBody(schema)`; export the inferred type (`z.infer`) for the service to consume. There is no query/params validator yet — add one to `validate.middleware.ts` rather than validating inline.
- Routes requiring login use `authenticate`; admin-only routes chain `authenticate, authorize('admin')`. Apply them as `router.use(...)` at the top of the module's routes file when the whole resource is protected, rather than per-route.
- `authRateLimiter` (15 min / 10 requests) is applied per-route on `/auth/register` and `/auth/login` only.
- **ESM: every relative import needs an explicit `.js` extension** (`./auth.service.js`), even though the source file is `.ts`. `NodeNext` resolution will not find extensionless imports.
- `noUncheckedIndexedAccess` is on, so array/index access is `T | undefined` — destructured Drizzle `.returning()` results need a guard (see `auth.service.ts` `if (!user) throw ...`).
- Strip `passwordHash` before returning a user (`sanitizeUser` in `auth.service.ts`).

## Database

- Schema lives entirely in `src/db/schema.ts`. After editing it, run `npm run db:generate` then `npm run db:migrate` — never hand-write SQL migrations.
- Adding a new table also means adding its `relations(...)` block if it needs `db.query.<table>` with `with:`, and the table must be exported from `schema.ts` (the whole module is passed to `drizzle(sqlite, { schema })`).
- Seeding: `src/db/seed.ts` (`npm run db:seed`) loads `data/categories.json`. It opens its own better-sqlite3 connection from `DATABASE_URL` rather than importing `config/env.ts`, so it doesn't demand JWT secrets just to open the DB; it preserves explicit ids and upserts on conflict, so re-running is safe and won't break `products.category_id` references.
- `src/db/seed-products.ts` (`npm run db:seed:products`) loads `data/products.json` (1271 rows) the same way. **Order matters:** `products.category_id` is a real FK, so `db:seed` must run before `db:seed:products`; the script pre-checks that every referenced category id exists and fails with a pointer to `db:seed` rather than surfacing a bare "FOREIGN KEY constraint failed".
- `data/categories.json` still carries a `parentId` field the schema no longer has; the categories seeder validates it, ignores it, and warns.
- Beyond that, do not seed data unless explicitly asked.

## Environment

There is currently **no `.env.example` in the repo** — create `.env` with at least:

```
JWT_ACCESS_SECRET=<32+ chars>   # openssl rand -hex 32
JWT_REFRESH_SECRET=<32+ chars>
```

Optional, with defaults: `NODE_ENV=development`, `PORT=3000`, `DATABASE_URL=./data/dev.db`, `ACCESS_TOKEN_TTL=15m`, `REFRESH_TOKEN_TTL_DAYS=30`. Both JWT secrets must be ≥32 characters or the app throws on boot.

## Known repo hygiene gaps

- `.gitignore` currently ignores `drizzle/` wholesale, so **generated migrations are not committed** — `db:migrate` can't reproduce the schema on a fresh clone. Ignore only `drizzle/` build noise, not the migration SQL, if this is meant to be shareable.
- `.gitignore` does **not** cover `.env`, `dist/`, or `*.db-shm`/`*.db-wal`. Don't commit those regardless.
- `npm audit` reports 4 moderate advisories, all from one transitive chain: `drizzle-kit` → `@esbuild-kit/esm-loader` → `esbuild <=0.24.2` (dev-server request forgery). It is dev-tooling only and `npm audit fix --force` would downgrade drizzle-kit to 0.18.1, so it is knowingly left alone — don't "fix" it.
- `src/.DS_Store` and `src/modules/.DS_Store` are still tracked despite the `.DS_Store` ignore rule (ignore rules don't apply to already-tracked files); they need `git rm --cached` to actually go away.

## What Not to Do

- Don't add a new HTTP client/ORM library without checking this file first — Drizzle + `better-sqlite3` is the intended stack for this project's lifetime (SQLite is a deliberate choice for the sample; swapping to Postgres is a future step, not implied by any single task).
- Don't remove the dummy-data TODOs' surrounding structure (route protection, response shape) when replacing them with real logic — only the data source should change.
- The dist folder in the root directory stores the compiled source code of the app. Do not touch this folder (including any files inside it) and do not make any changes to any of the files inside this.
