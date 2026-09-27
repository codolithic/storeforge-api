import rateLimit from 'express-rate-limit';

// Auth endpoints are the classic brute-force / credential-stuffing target,
// so they get a tighter limit than the rest of the API.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, please try again later.' },
  },
});
