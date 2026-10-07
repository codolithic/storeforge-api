import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

// Generic request-body validator: parses+replaces req.body with the typed,
// validated result. Throws a ZodError on failure, caught by errorHandler.
export const validateBody =
  (schema: ZodType) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    req.body = schema.parse(req.body);
    next();
  };

// Query-string validator. Express 5 makes req.query a read-only getter, so the
// parsed result is stored on res.locals.query instead of replacing req.query.
export const validateQuery =
  (schema: ZodType) =>
  (req: Request, res: Response, next: NextFunction): void => {
    res.locals.query = schema.parse(req.query);
    next();
  };

// Route-params validator; stores the parsed result on res.locals.params to
// mirror validateQuery (Express 5 types req.params values as string | string[]).
export const validateParams =
  (schema: ZodType) =>
  (req: Request, res: Response, next: NextFunction): void => {
    res.locals.params = schema.parse(req.params);
    next();
  };
