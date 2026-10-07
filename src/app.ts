import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from '@config/env.js';
import { createDocsRouter } from './docs/docs.routes.js';
import routes from '@routes/index.js';
import { notFoundHandler, errorHandler } from '@middlewares/error.middleware.js';

export const app = express();

app.use(helmet());
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// OpenAPI spec at /api/docs/openapi.json and the Scalar reference UI at /api/docs.
if (env.ENABLE_API_DOCS ?? env.NODE_ENV !== 'production') {
  app.use('/api/docs', createDocsRouter());
}

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);
