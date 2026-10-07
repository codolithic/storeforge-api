import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { ApiError } from './error.middleware.js';

declare global {
  namespace Express {
    interface Request {
      user?: { id: number; role: 'customer' | 'admin' };
    }
  }
}

// Verifies the Bearer access token and attaches the identity to req.user.
// TODO - Whey do we use Bearer based auth instead of cookie based one?
export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid Authorization header');
  }

  try {
    const payload = verifyAccessToken(header.slice(7));
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }
};

// Role-based access control — chain after `authenticate`.
// Usage: router.patch('/admin/orders/:id', authenticate, authorize('admin'), handler)
export const authorize =
  (...roles: Array<'customer' | 'admin'>) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
    next();
  };
