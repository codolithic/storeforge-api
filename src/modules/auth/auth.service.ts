import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { refreshTokens, users } from '../../db/schema.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateRefreshToken, hashToken, signAccessToken } from '../../utils/jwt.js';
import { ApiError } from '../../middlewares/error.middleware.js';
import { env } from '../../config/env.js';
import type { LoginInput, RegisterInput } from './auth.types.js';

const REFRESH_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

async function issueTokenPair(userId: number, role: 'customer' | 'admin') {
  const accessToken = signAccessToken({ sub: userId, role });
  const refreshToken = generateRefreshToken();

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  });

  return { accessToken, refreshToken };
}

function sanitizeUser(user: typeof users.$inferSelect) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export async function register(input: RegisterInput) {
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) {
    throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
  }

  const passwordHash = await hashPassword(input.password);
  const [user] = await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
    })
    .returning();

  if (!user) throw new ApiError(500, 'INTERNAL_ERROR', 'Failed to create user');

  const tokens = await issueTokenPair(user.id, user.role as 'customer' | 'admin');
  return { user: sanitizeUser(user), ...tokens };
}

export async function login(input: LoginInput) {
  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (!user || !(await verifyPassword(user.passwordHash, input.password))) {
    // Deliberately identical error for "no such user" and "wrong password" —
    // never reveal which one it was, that leaks which emails are registered.
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  const tokens = await issueTokenPair(user.id, user.role as 'customer' | 'admin');
  return { user: sanitizeUser(user), ...tokens };
}

export async function refresh(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const record = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, tokenHash) });

  if (!record || record.revokedAt || new Date(record.expiresAt) < new Date()) {
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  // Rotation: the used token is revoked immediately and a fresh pair issued.
  // If a stolen refresh token is ever replayed after the legitimate user has
  // already rotated it, this detects/limits reuse instead of accepting it forever.
  await db.update(refreshTokens).set({ revokedAt: new Date().toISOString() }).where(eq(refreshTokens.id, record.id));

  const user = await db.query.users.findFirst({ where: eq(users.id, record.userId) });
  if (!user) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'User no longer exists');

  return issueTokenPair(user.id, user.role as 'customer' | 'admin');
}

export async function logout(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(refreshTokens.tokenHash, tokenHash));
}
