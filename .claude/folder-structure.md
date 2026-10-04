Layered, feature-first structure:

- src/config/env.ts - zod-parsed env, evaluated at import time, fails fast on boot
- src/db/schema.ts - all Drizzle tables + relations
- src/db/index.ts - better-sqlite3 client (WAL + foreign_keys ON), exports `db` and all tables
- src/db/seed-*.ts - related to utility code to seed the database
- src/middlewares/ - auth, error, rateLimiter, validate
- src/modules/ - one folder per resource: auth, products, categories, cart, orders, admin
  - *.controller.ts - a bridge between the route and the business layer
  - *.routes.ts - provides a routes for the specific module
  - *.service.ts - implements a business layer
  - *.types.ts - provides a types required by the module controller, routes and service
  - *.openapi.ts - OpenAPI paths for the module's routes (request schemas from *.types.ts, docs-only response schemas)
- src/routes/index.ts - aggregates module routers (exported `mounts` table), mounted at /api by app.ts
- src/docs/ - OpenAPI document builder, shared doc helpers, and the /api/docs router (Scalar UI + openapi.json)
- scripts/ - dev scripts run with tsx (e.g. lint-openapi.ts for `npm run docs:lint`)
- src/utils/ - apiResponse, jwt, password
- src/app.ts - express app + global middleware + /health
- src/server.ts - entry point (app.listen)
