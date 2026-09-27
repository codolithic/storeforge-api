import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';

// Generic request-body validator: parses+replaces req.body with the typed,
// validated result. Throws a ZodError on failure, caught by errorHandler.
export const validateBody =
  (schema: ZodSchema) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    req.body = schema.parse(req.body);
    next();
  };
