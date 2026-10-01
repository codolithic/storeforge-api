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
- src/routes/index.ts - aggregates module routers, mounted at /api by app.ts
- src/utils/ - apiResponse, jwt, password
- src/app.ts - express app + global middleware + /health
- src/server.ts - entry point (app.listen)
