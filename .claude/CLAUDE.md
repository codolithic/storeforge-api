# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**StoreForge API** — a sample e-commerce backend built with Express.js, TypeScript, and SQLite (via Drizzle ORM). It follows patterns used by real e-commerce platforms (variant-level inventory, order snapshots, inventory reservations, refresh-token rotation) while staying simple enough to run locally with a file-based DB.

## Tech Stack

All dependencies use the latest stable version as of 30-Sep-2026; `npx tsc --noEmit`, `npm run build`, and a runtime smoke test pass on this set.

- Node.js `engines: >=24` (developed on v26), ESM only (`"type": "module"`)
- Express 5.2, with helmet 8.3, cors 2.8, cookie-parser 1.4, express-rate-limit 8.7
- TypeScript 7.0, `strict` + `noUncheckedIndexedAccess`, `module: NodeNext`
- Drizzle ORM 0.45 + drizzle-kit 0.31, on better-sqlite3 13
- Zod 4.6 for validation
- jsonwebtoken 9.0 (access tokens) + argon2 0.45 (password hashing)
- Pino 10 / pino-http 11 are installed but **not wired up** (`pinoHttp()` is commented out in `app.ts`); logging is `console.*`, and `db/index.ts` enables Drizzle's `logger: true`, so every SQL query is printed
- dotenv 18 for env loading
- Prettier 3.9 (config in `.prettierrc`)
- Vitest 5 + supertest 7.3 for tests

## Commands

```bash
npm run dev          # start dev server with hot reload (tsx watch src/server.ts)
npm run build        # compile TypeScript to dist/
npm start            # run compiled server (node dist/server.js)
npm run db:generate  # generate a Drizzle migration from src/db/schema.ts
npm run db:migrate   # apply migrations to the SQLite file
npm run db:studio    # open Drizzle Studio to inspect data
npm run db:seed      # load all data/*.json into the database (idempotent)
npm test             # vitest run
npm run typecheck    # type-check only
npm run format       # format all the files
```

Always run `npm run typecheck` and `npm test` after making changes before considering a task done. There is no linter. Prettier is configured (single quotes, semicolons, trailing commas, `printWidth: 100`) but not enforced, and a few files (`error.middleware.ts`, `auth.service.ts`, `utils/jwt.ts`) aren't formatted yet — run Prettier on the files you change, not repo-wide, to keep diffs focused.

### Tests

Vitest 5 + supertest. **All tests live in the top-level `tests/` folder, separate from `src/`, and test at the route level only**: one `tests/<resource>.test.ts` per resource, driving the real `app` over HTTP with supertest (no `listen`). Don't add per-file unit tests for controllers, services, schemas, or middleware — cover that behaviour through the routes (e.g. schema rules as 400 `VALIDATION_ERROR` cases). Run one file or one case with:

```bash
npm test
npx vitest run tests/products.test.ts
npx vitest run -t "treats % as a literal character"
```

How the setup works (`vitest.config.ts` + `tests/`):

- `test.env` sets `NODE_ENV=test`, dummy JWT secrets, and `DATABASE_URL=:memory:` before any import, because `config/env.ts` and `db/index.ts` read the environment and open the DB at import time. `dotenv` doesn't override already-set vars, so `.env` never leaks into tests.
- Test files run isolated, so each file gets its **own fresh in-memory DB**. Each file calls `migrateTestDb()` from `tests/helpers/db.ts` (builds the schema from the committed `drizzle/` migrations; throws if `DATABASE_URL` isn't `:memory:`) and seeds a fixture in `beforeAll`. The Drizzle SQL logger is off under `NODE_ENV=test`.
- Use small hand-built fixtures in `tests/fixtures/` (e.g. `catalog.ts`), never `data/*.json` — it's gitignored and too large to assert against. Assertions depend on exact fixture rows, so changing a fixture means updating expectations.
- `authRateLimiter` keeps in-memory state per test file; `tests/auth.test.ts` resets it in `beforeEach` via `authRateLimiter.resetKey(ipKeyGenerator(ip))` for the loopback IPs. Do the same in any file that hits `/auth/register` or `/auth/login` more than 10 times.
- Tests import source as `../src/...js`. `tests/tsconfig.json` extends the root config so `npm run typecheck` (`tsc --noEmit && tsc -p tests`) type-checks `tests/` too — Vitest itself doesn't type-check. `npm run build` only compiles `src/`, so tests never land in `dist/`.

## Architecture

Follow @folder-structure.md for directories and files structure.

Routes are mounted at **`/api`** (e.g. `/api/products`, `/api/auth/login`), not a versioned prefix.

**Request pipeline:** `routes` → `controller` (HTTP only, thin) → `service` (business logic, Drizzle) → `db`.

**File naming inside a module is prefixed, not bare:** `auth.routes.ts`, `auth.controller.ts`, `auth.service.ts`, `auth.types.ts` — not `routes.ts`. Follow this when adding files.

**Implementation status** — being filled in incrementally:

- `auth` — full service layer; the reference pattern: `types.ts` (Zod schemas) → `service.ts` (logic) → `controller.ts` (calls the service) → `routes.ts` (wires middleware).
- `products` — `GET /products` is real (`products.service.ts`: pagination, category-slug filter including subcategories, name search, `basePrice` range, sort; lists only `status = 'active'`). `GET /products/:slug` is real too (category, images, and variants with `inStock` instead of the raw stock count; 404 for non-active products).
- `categories` — `GET /categories` is real and controller calls categories service to list categories; the categories service builds a two-level menu from `parentId`.
- `cart` — real (`cart.service.ts`): `GET /cart`, `POST /cart/items` (merges a repeated variant into its line), `PATCH /cart/items/:id`, `DELETE /cart/items/:id`, all scoped to the caller's newest `active` cart. Stock and a 99-unit line cap are checked on every write; mutations run as synchronous better-sqlite3 transactions so get-or-create of the cart/line can't race.
- `orders` — real (`orders.service.ts`): `POST /orders` checks out the caller's active cart into a `pending` order (current variant price/name/attributes snapshotted into `order_items`, stock held via 15-min `inventory_reservations` net of other live holds, cart marked `converted`, optional `shippingAddressId` else the default address; tax/shipping are 0). `GET /orders` (paginated, `status` filter), `GET /orders/:id`, and `POST /orders/:id/cancel` (pending only, conditional `UPDATE`, releases reservations). Other users' orders are 404.
- `admin` — returns **dummy JSON** marked with `// TODO: replace with real Drizzle queries`. `admin` has no controller at all; its dummy handlers are inline in `admin.routes.ts` and should be extracted into `admin.controller.ts` + `admin.service.ts` when implemented.

## Domain model (read before touching catalog/cart/order code)

- **Price and stock live on `product_variants`, never on `products`.** `products.basePrice` is a display/starting price only; `product_variants.price` and `product_variants.stockQuantity` are authoritative. `cart_items` and `order_items` reference `variantId`, not `productId`.
- **Never live-join order data to current product/price.** `order_items` snapshots `productName`, `variantAttributes`, and `unitPrice` at purchase time; `cart_items` snapshots `unitPriceSnapshot`. Preserve this when writing cart/order logic.
- **Categories are a self-referencing tree** via nullable `categories.parentId`; the data is two levels deep (10 roots) and the menu builder assumes that. Products are attached to both root and child categories.
- **Carts support guests:** `carts.userId` is nullable and `carts.sessionId` identifies an anonymous cart. Current cart routes are all behind `authenticate`, so the guest path is modelled but not yet wired up.
- **`inventory_reservations`** are short-lived stock holds taken during checkout and released on failure/timeout — checkout logic should create them rather than decrementing `stockQuantity` directly.
- `payments` and `reviews` tables exist in the schema but nothing uses them yet.
- **Column types:** timestamps are `text` ISO-8601 strings defaulting to `current_timestamp`, and all money is `real` (SQLite float). Stay consistent with both rather than introducing a second convention.

## Auth flow

- Access token: short-lived JWT (`ACCESS_TOKEN_TTL`, default `15m`), payload `{ sub: userId, role }`, verified per-request with no DB hit.
- Refresh token: opaque `crypto.randomBytes(48)` hex string, **never a JWT**, SHA-256 hashed before storage in `refresh_tokens`. Never store or log the raw token.
- The refresh token travels in an **httpOnly `refresh_token` cookie** (`sameSite: 'strict'`, `secure` in production), set by `auth.controller.ts` — not in the JSON body. `/auth/refresh` and `/auth/logout` read it from `req.cookies`.
- Every use of a refresh token rotates it: the old row is claimed and marked `revokedAt` in a **single conditional `UPDATE ... RETURNING`** (not find-then-update), then a fresh pair is issued. Keep it atomic — it's what stops two concurrent refreshes from both succeeding.
- **Reuse detection:** presenting an already-revoked token (a replayed rotated token, or one used after logout) revokes _all_ of that user's live sessions and returns 401. Logout revokes only the current session.
- Login returns an identical error for unknown-email and wrong-password; don't split them (it leaks which emails are registered). The unknown-email path also runs argon2 against a dummy hash so response _time_ doesn't leak it either — don't short-circuit it.
- Emails are trimmed + lowercased by the Zod schema (`auth.types.ts`) before reaching the service, so all lookups assume normalised emails. Register uses `onConflictDoNothing` on `users.email` so duplicate sign-ups are a 409, never a constraint 500.
- The `refresh_token` cookie must be cleared with the same attributes it was set with (`baseCookieOptions` in `auth.controller.ts`).
- Don't extend access-token lifetime as a shortcut instead of using the refresh flow.

## Conventions

- All route handlers are `async`. Express 5 forwards rejected promises (and synchronous throws) to `errorHandler`, so **no manual try/catch or async wrapper** anywhere.
- Throw `ApiError(status, code, message)` (from `middlewares/error.middleware.ts`) for expected failures. `errorHandler` also maps `ZodError` → 400 `VALIDATION_ERROR` (with per-field `details`) automatically. Prefer throwing `ApiError` over calling `sendError`; some controllers still use `sendError` and should switch when they get real logic.
- Every response uses the shared envelope from `utils/apiResponse.ts` — `sendSuccess(res, data, status?)` → `{ success, data }`, errors → `{ success: false, error: { code, message } }`. Don't hand-roll response shapes. Paginated lists return `{ items, pagination: { page, limit, total, totalPages } }`.
- Validate input with a Zod schema in the module's `*.types.ts` and export the inferred type (`z.infer`) for the service to consume:
  - bodies: `validateBody(schema)` — replaces `req.body` with the parsed result.
  - query strings: `validateQuery(schema)` — Express 5's `req.query` is a read-only getter that re-parses on every access, so the parsed result goes on **`res.locals.query`**; read it from there (cast to the inferred type), not from `req.query`. Use `z.coerce` for numbers, since query values arrive as strings.
  - route params: `validateParams(schema)` — stores the parsed result on **`res.locals.params`** (Express 5 types `req.params` values as `string | string[]`, so reading them raw doesn't type-check).
- Routes requiring login use `authenticate`; admin-only routes chain `authenticate, authorize('admin')`. Apply them as `router.use(...)` at the top of the module's routes file when the whole resource is protected, rather than per-route.
- `authRateLimiter` (15 min / 10 requests) is applied per-route on `/auth/register` and `/auth/login` only.
- **ESM: every relative import needs an explicit `.js` extension** (`./auth.service.js`), even though the source file is `.ts`. `NodeNext` resolution will not find extensionless imports.
- `noUncheckedIndexedAccess` is on, so array/index access is `T | undefined` — destructured Drizzle `.returning()` / aggregate results need a guard or default (see `auth.service.ts` `if (!user) throw ...`).
- Strip `passwordHash` before returning a user (`sanitizeUser` in `auth.service.ts`).

## Database

- Schema lives entirely in `src/db/schema.ts`. After editing it, run `npm run db:generate` then `npm run db:migrate` — never hand-write SQL migrations. `drizzle.config.ts` hardcodes `./data/dev.db` rather than reading `DATABASE_URL`.
- Adding a new table also means adding its `relations(...)` block if it needs `db.query.<table>` with `with:`, and the table must be exported from `schema.ts` (the whole module is passed to `drizzle(sqlite, { schema })`).
- **Seeding** (`npm run db:seed` → `src/db/seed.ts`) loads 10 files from `data/` in FK-dependency order: users → addresses → categories → products → product_images → product_variants → carts → cart_items → orders → order_items. Each file is validated with a Zod schema in `seed-schema.ts`, then written by the generic `seedTable()` in `seed-table.ts`, which upserts on `id` inside a transaction, so re-running is safe and explicit ids are preserved.
  - `seed-table.ts` opens its own better-sqlite3 connection per table and does **not** import `config/env.ts` (so no JWT secrets needed) — and it doesn't load dotenv either, so it uses `process.env.DATABASE_URL` or `./data/dev.db`, ignoring `.env`.
  - `seed.ts` catches errors and only logs `❌ Seeding Failed <message>`, **exiting 0** — check the output, not the exit code. A failure partway leaves the earlier tables seeded.
  - Adding a seeded table means: a schema in `seed-schema.ts`, a source file in `data/`, and a `seedTable` call in the correct FK position in `seed.ts`.
- Beyond that, do not seed data unless explicitly asked.

## Database tables

For a guide on database tables, columns and relations between tables follow @db-schema.md.

## Environment

There is currently **no `.env.example` in the repo** — create `.env` with at least:

```
JWT_ACCESS_SECRET=<32+ chars>   # openssl rand -hex 32
JWT_REFRESH_SECRET=<32+ chars>
```

Optional, with defaults: `NODE_ENV=development`, `PORT=3000`, `DATABASE_URL=./data/dev.db`, `ACCESS_TOKEN_TTL=15m`, `REFRESH_TOKEN_TTL_DAYS=30`. Both JWT secrets must be ≥32 characters or the app throws on boot.

## Known repo hygiene gaps

- `.gitignore` ignores `data/` wholesale, so **the seed JSON files and `dev.db` are not committed** — `npm run db:seed` can't run on a fresh clone. It also ignores `drizzle/` wholesale, so **generated migrations are not committed** and `db:migrate` can't reproduce the schema either. Ignore only `data/*.db*` and drizzle build noise if this is meant to be shareable.
- `npm audit` reports 4 moderate advisories, all from one transitive chain: `drizzle-kit` → `@esbuild-kit/esm-loader` → `esbuild <=0.24.2` (dev-server request forgery). It is dev-tooling only and `npm audit fix --force` would downgrade drizzle-kit to 0.18.1, so it is knowingly left alone — don't "fix" it.
- `src/.DS_Store` and `src/modules/.DS_Store` are still tracked despite the `.DS_Store` ignore rule (ignore rules don't apply to already-tracked files); they need `git rm --cached` to actually go away.

## What Not to Do

- Don't add a new HTTP client/ORM library without checking this file first — Drizzle + `better-sqlite3` is the intended stack for this project's lifetime (SQLite is a deliberate choice for the sample).
- Don't remove the dummy-data TODOs' surrounding structure (route protection, response shape) when replacing them with real logic — only the data source should change.
- The dist folder in the root directory stores the compiled source code of the app. Do not touch this folder (including any files inside it) and do not make any changes to any of the files inside this.
- There are seeding related files in src/db - seed-schema.ts, seed-table.ts and seed.ts. Do not touch these files.
- If you ever need to make changes to src/db/schema.ts first ask even when you are in auto mode.
