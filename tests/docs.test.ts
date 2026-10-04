import SwaggerParser from '@apidevtools/swagger-parser';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app.js';
import { mounts } from '../src/routes/index.js';

// The docs routes never touch the DB, so this file doesn't migrate or seed one.

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

type RouteLayer = { route?: { path: string; methods: Record<string, boolean> } };

// "METHOD /api/path/{param}" for every route registered on the module routers.
function mountedOperations() {
  const operations = ['GET /health'];
  for (const [mountPath, router] of mounts) {
    for (const layer of router.stack as RouteLayer[]) {
      if (!layer.route) continue;
      const path = `/api${mountPath}${layer.route.path === '/' ? '' : layer.route.path}`;
      for (const method of Object.keys(layer.route.methods)) {
        operations.push(`${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`);
      }
    }
  }
  return operations.sort();
}

function documentedOperations(paths: Record<string, Record<string, unknown>>) {
  return Object.entries(paths)
    .flatMap(([path, item]) =>
      HTTP_METHODS.filter((m) => m in item).map((m) => `${m.toUpperCase()} ${path}`),
    )
    .sort();
}

describe('GET /api/docs/openapi.json', () => {
  it('serves a valid OpenAPI 3.1 document', async () => {
    const res = await request(app).get('/api/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('StoreForge API');
    await expect(SwaggerParser.validate(res.body)).resolves.toBeDefined();
  });

  it('documents exactly the routes the app serves', async () => {
    const res = await request(app).get('/api/docs/openapi.json');

    expect(documentedOperations(res.body.paths)).toEqual(mountedOperations());
  });

  it('gives every operation a unique operationId', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    const ids = Object.values(res.body.paths as Record<string, Record<string, unknown>>).flatMap(
      (item) =>
        HTTP_METHODS.flatMap((m) => {
          const op = item[m] as { operationId?: string } | undefined;
          return op ? [op.operationId] : [];
        }),
    );

    expect(ids).not.toContain(undefined);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks public routes as unauthenticated and protected ones as bearer', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    const { paths } = res.body;

    expect(paths['/api/products'].get.security).toEqual([]);
    expect(paths['/api/reviews'].get.security).toEqual([]);
    expect(paths['/api/reviews'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(paths['/api/auth/refresh'].post.security).toEqual([{ refreshCookie: [] }]);
    expect(res.body.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('documents query parameters from the Zod validators', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    const params = res.body.paths['/api/reviews'].get.parameters;

    expect(params).toContainEqual(
      expect.objectContaining({ in: 'query', name: 'productId', required: true }),
    );
    expect(params).toContainEqual(
      expect.objectContaining({
        in: 'query',
        name: 'limit',
        schema: expect.objectContaining({ type: 'integer', default: 20, maximum: 100 }),
      }),
    );
  });

  it('lists the exact error codes a route can return', async () => {
    const res = await request(app).get('/api/docs/openapi.json');
    const conflict = res.body.paths['/api/payments'].post.responses['409'];

    expect(conflict.description).toBe(
      'Conflict: ORDER_NOT_PAYABLE, PAYMENT_IN_PROGRESS, CHECKOUT_EXPIRED',
    );
    expect(
      conflict.content['application/json'].schema.properties.error.properties.code.enum,
    ).toEqual(['ORDER_NOT_PAYABLE', 'PAYMENT_IN_PROGRESS', 'CHECKOUT_EXPIRED']);
  });
});

describe('GET /api/docs', () => {
  it('serves the Scalar reference page pointing at the spec', async () => {
    const res = await request(app).get('/api/docs');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('"url": "/api/docs/openapi.json"');
  });

  it('allows only its own scripts via a fresh per-request CSP nonce', async () => {
    const first = await request(app).get('/api/docs');
    const second = await request(app).get('/api/docs');

    const nonceOf = (res: request.Response) =>
      /script-src [^;]*'nonce-([^']+)'/.exec(res.headers['content-security-policy'] ?? '')?.[1];
    const nonce = nonceOf(first);
    expect(nonce).toBeDefined();
    expect(nonceOf(second)).not.toBe(nonce);
    expect(first.text).toContain(`<script type="text/javascript" nonce="${nonce}">`);
    expect(first.headers['content-security-policy']).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('keeps helmet’s strict CSP on the rest of the API', async () => {
    const res = await request(app).get('/health');

    expect(res.headers['content-security-policy']).toContain("script-src 'self';");
  });
});

describe('docs toggle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // env.ts is evaluated at import time, so each case re-imports a fresh app.
  async function freshApp(vars: Record<string, string | undefined>) {
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
    vi.resetModules();
    return (await import('../src/app.js')).app;
  }

  it('is off in production by default', async () => {
    const prodApp = await freshApp({ NODE_ENV: 'production', ENABLE_API_DOCS: undefined });

    expect((await request(prodApp).get('/api/docs')).status).toBe(404);
    expect((await request(prodApp).get('/api/docs/openapi.json')).status).toBe(404);
  });

  it('can be enabled in production with ENABLE_API_DOCS=true', async () => {
    const prodApp = await freshApp({ NODE_ENV: 'production', ENABLE_API_DOCS: 'true' });

    expect((await request(prodApp).get('/api/docs/openapi.json')).status).toBe(200);
  });

  it('can be disabled outside production with ENABLE_API_DOCS=false', async () => {
    const devApp = await freshApp({ ENABLE_API_DOCS: 'false' });

    expect((await request(devApp).get('/api/docs')).status).toBe(404);
  });
});
