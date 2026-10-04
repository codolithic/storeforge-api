import { randomBytes } from 'node:crypto';
import { apiReference } from '@scalar/express-api-reference';
import { Router, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { buildOpenApiDocument } from './openapi.js';

const SPEC_PATH = '/api/docs/openapi.json';
const SCALAR_CDN = 'https://cdn.jsdelivr.net';

// The Scalar page loads its bundle from jsDelivr and runs one inline init
// script, so it needs a looser CSP than helmet's default. This one replaces the
// global header for the docs page only; the inline script is allowed by a
// per-request nonce rather than 'unsafe-inline'.
const docsCsp = helmet.contentSecurityPolicy({
  directives: {
    scriptSrc: [
      "'self'",
      SCALAR_CDN,
      (_req, res) => `'nonce-${(res as Response).locals.cspNonce}'`,
    ],
    styleSrc: ["'self'", "'unsafe-inline'", SCALAR_CDN],
    fontSrc: ["'self'", 'https:', 'data:'],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
    workerSrc: ["'self'", 'blob:'],
  },
});

function setCspNonce(_req: Request, res: Response, next: NextFunction): void {
  res.locals.cspNonce = randomBytes(16).toString('base64');
  next();
}

// Built once when the router is created, not per request.
export function createDocsRouter(): Router {
  const document = buildOpenApiDocument();
  const router = Router();

  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  // Created per request so the page's script tags carry this response's nonce.
  // Scalar types its handler as RequestHandler<never>, hence the req cast.
  router.get('/', setCspNonce, docsCsp, (req, res, next) => {
    apiReference({
      url: SPEC_PATH,
      pageTitle: 'StoreForge API Reference',
      nonce: res.locals.cspNonce as string,
    })(req as never, res, next);
  });

  return router;
}
