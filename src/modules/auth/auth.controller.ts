import type { Request, Response } from 'express';
import { sendSuccess } from '@utils/apiResponse.js';
import { env } from '@config/env.js';
import { ApiError } from '@middlewares/error.middleware.js';
import * as authService from './auth.service.js';

const REFRESH_COOKIE = 'refresh_token';

// httpOnly + sameSite=strict so the refresh token is never reachable from
// client-side JS (mitigates XSS token theft); secure in production (HTTPS only).
const baseCookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
};

const cookieOptions = {
  ...baseCookieOptions,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

export async function register(req: Request, res: Response): Promise<void> {
  const { accessToken, refreshToken, user } = await authService.register(req.body);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  sendSuccess(res, { user, accessToken }, 201);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { accessToken, refreshToken, user } = await authService.login(req.body);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  sendSuccess(res, { user, accessToken });
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    throw new ApiError(401, 'UNAUTHORIZED', 'No refresh token provided');
  }
  const { accessToken, refreshToken } = await authService.refresh(token);
  res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions);
  sendSuccess(res, { accessToken });
}

export async function logout(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await authService.logout(token);
  // Browsers only drop the cookie if the attributes match the ones it was set with.
  res.clearCookie(REFRESH_COOKIE, baseCookieOptions);
  sendSuccess(res, { message: 'Logged out' });
}
