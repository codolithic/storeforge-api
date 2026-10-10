import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
};

// Express 5 automatically forwards rejected promises from async route
// handlers/middleware to this error handler — no manual try/catch or
// wrapper function needed in controllers.
export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof ApiError) {
    res
      .status(err.status)
      .json({ success: false, error: { code: err.code, message: err.message } });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request data', details: err.flatten() },
    });
    return;
  }

  console.error(err);
  res
    .status(500)
    .json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
};
