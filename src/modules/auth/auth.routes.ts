import { Router } from 'express';
import * as authController from './auth.controller.js';
import { validateBody } from '@middlewares/validate.middleware.js';
import { loginSchema, registerSchema } from './auth.types.js';
import { authRateLimiter } from '@middlewares/rateLimiter.middleware.js';

const router = Router();

router.post('/register', authRateLimiter, validateBody(registerSchema), authController.register);
router.post('/login', authRateLimiter, validateBody(loginSchema), authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export default router;
