import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '@db/index.js';
import { refreshTokens, users } from '@db/schema.js';
import { hashPassword, verifyPassword } from '@utils/password.js';
import { generateRefreshToken, hashToken, signAccessToken } from '@utils/jwt.js';
import { ApiError } from '@middlewares/error.middleware.js';
import { env } from '@config/env.js';
import type { LoginInput, RegisterInput } from './auth.types.js';

const REFRESH_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

type User = typeof users.$inferSelect;

async function issueTokenPair(userId: number, role: User['role']) {
  const accessToken = signAccessToken({ sub: userId, role });
  const refreshToken = generateRefreshToken();

  await db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
  });

  return { accessToken, refreshToken };
}

function sanitizeUser(user: User) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

// Login verifies against this when the email is unknown, so both failure paths
// pay the same argon2 cost and response time doesn't reveal registered emails.
let dummyPasswordHash: Promise<string> | undefined;
const getDummyPasswordHash = () =>
  (dummyPasswordHash ??= hashPassword('timing-equaliser-not-a-real-password'));

export async function register(input: RegisterInput) {
  const passwordHash = await hashPassword(input.password);

  // onConflictDoNothing (rather than check-then-insert) keeps two simultaneous
  // sign-ups with the same email a clean 409 instead of a unique-constraint 500.
  const [user] = await db
    .insert(users)
    .values({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
    })
    .onConflictDoNothing({ target: users.email })
    .returning();

  if (!user) {
    throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
  }

  const tokens = await issueTokenPair(user.id, user.role);
  return { user: sanitizeUser(user), ...tokens };
}

export async function login(input: LoginInput) {
  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  const passwordMatches = await verifyPassword(
    user?.passwordHash ?? (await getDummyPasswordHash()),
    input.password,
  );

  if (!user || !passwordMatches) {
    // Deliberately identical error for "no such user" and "wrong password" —
    // never reveal which one it was, that leaks which emails are registered.
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }

  const tokens = await issueTokenPair(user.id, user.role);
  return { user: sanitizeUser(user), ...tokens };
}

export async function refresh(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const now = new Date().toISOString();

  // Rotation: revoke the presented token and claim it in a single UPDATE, so two
  // concurrent requests with the same token can't both be issued a new pair.
  const [claimed] = await db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, now),
      ),
    )
    .returning({ userId: refreshTokens.userId });

  if (!claimed) {
    // Reuse detection: a token that was already rotated/revoked is being replayed,
    // so either it was stolen or the legitimate client is holding a stale copy.
    // Revoke every live session for the user so a thief's rotated token dies too.
    const existing = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
    });
    if (existing?.revokedAt) {
      await db
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, existing.userId), isNull(refreshTokens.revokedAt)));
    }
    throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, claimed.userId) });
  if (!user) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'User no longer exists');

  return issueTokenPair(user.id, user.role);
}

export async function logout(rawToken: string) {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(rawToken)), isNull(refreshTokens.revokedAt)));
}
