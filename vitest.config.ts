import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolves the package.json `imports` aliases (#config/*, #db/*, ...) to src/ instead of dist/.
  // The rest are Vite's default server conditions, which this list replaces.
  ssr: {
    resolve: {
      conditions: ['storeforge-src', 'module', 'node', 'development|production'],
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Applied to process.env before any test file is imported, so config/env.ts
    // parses these instead of .env (dotenv never overrides already-set vars).
    // Each test file runs isolated, so ':memory:' gives every file its own fresh DB.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: ':memory:',
      JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
      JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
    },
  },
});
