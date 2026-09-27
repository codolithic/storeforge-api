import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: number;
  role: 'customer' | 'admin';
}

// Short-lived, stateless JWT — verified on every request without a DB hit.
export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] });

export const verifyAccessToken = (token: string): AccessTokenPayload & jwt.JwtPayload =>
  jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload & jwt.JwtPayload;

// Refresh tokens are opaque random strings (NOT JWTs), stored hashed in the DB.
// This is the standard pattern for revocable sessions: a stateless JWT can't be
// invalidated before it expires, but a DB-backed opaque token can be revoked
// instantly on logout, password change, or suspected compromise, and rotated
// on every use to limit the blast radius of a stolen token.
export const generateRefreshToken = (): string => crypto.randomBytes(48).toString('hex');

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');
