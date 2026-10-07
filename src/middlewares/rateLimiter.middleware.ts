import rateLimit from 'express-rate-limit';

// Auth rate limit should not too frequent from a given device
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
