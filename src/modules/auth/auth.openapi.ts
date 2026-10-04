import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import {
  errors,
  json,
  refreshCookieAuth,
  timestamp,
  type Assert,
  type Documents,
  type ReturnOf,
} from '../../docs/openapi.helpers.js';
import type * as authService from './auth.service.js';
import { loginSchema, registerSchema } from './auth.types.js';

const userSchema = z
  .object({
    id: z.number().int(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    role: z.enum(['customer', 'admin']),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'User' });

const sessionSchema = z.object({ user: userSchema, accessToken: z.string() });
const accessTokenSchema = z.object({ accessToken: z.string() });

type _register = Assert<
  Documents<typeof userSchema, ReturnOf<typeof authService.register>['user']>
>;
type _refresh = Assert<
  Documents<typeof accessTokenSchema, Omit<ReturnOf<typeof authService.refresh>, 'refreshToken'>>
>;

const setsRefreshCookie = {
  'Set-Cookie': {
    description: 'httpOnly `refresh_token` cookie (sameSite=strict, secure in production)',
    schema: { type: 'string' as const },
  },
};

export const authPaths: ZodOpenApiPathsObject = {
  '/api/auth/register': {
    post: {
      tags: ['Auth'],
      operationId: 'register',
      security: [],
      summary: 'Register a customer account',
      description:
        'Email is trimmed and lowercased. Rate limited to 10 requests per 15 minutes per IP (shared with login).',
      requestBody: { content: { 'application/json': { schema: registerSchema } } },
      responses: {
        201: {
          ...json('Account created and signed in', sessionSchema),
          headers: setsRefreshCookie,
        },
        ...errors({
          400: ['VALIDATION_ERROR'],
          409: ['EMAIL_IN_USE'],
          429: ['TOO_MANY_REQUESTS'],
        }),
      },
    },
  },
  '/api/auth/login': {
    post: {
      tags: ['Auth'],
      operationId: 'login',
      security: [],
      summary: 'Log in',
      description:
        'Unknown email and wrong password return the same error. Rate limited to 10 requests per 15 minutes per IP.',
      requestBody: { content: { 'application/json': { schema: loginSchema } } },
      responses: {
        200: { ...json('Signed in', sessionSchema), headers: setsRefreshCookie },
        ...errors({
          400: ['VALIDATION_ERROR'],
          401: ['INVALID_CREDENTIALS'],
          429: ['TOO_MANY_REQUESTS'],
        }),
      },
    },
  },
  '/api/auth/refresh': {
    post: {
      tags: ['Auth'],
      operationId: 'refreshToken',
      summary: 'Rotate the refresh token and issue a new access token',
      description:
        'Reads the `refresh_token` cookie. Every use rotates it; replaying an already-rotated token revokes all of the user’s sessions.',
      security: refreshCookieAuth,
      responses: {
        200: { ...json('New token pair issued', accessTokenSchema), headers: setsRefreshCookie },
        ...errors({ 401: ['UNAUTHORIZED', 'INVALID_REFRESH_TOKEN'] }),
      },
    },
  },
  '/api/auth/logout': {
    post: {
      tags: ['Auth'],
      operationId: 'logout',
      summary: 'Log out the current session',
      description:
        'Revokes the session in the `refresh_token` cookie (if any) and clears the cookie.',
      security: refreshCookieAuth,
      responses: {
        200: json('Logged out', z.object({ message: z.string() })),
      },
    },
  },
};
