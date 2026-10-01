import { ipKeyGenerator } from 'express-rate-limit';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { db } from '../src/db/index.js';
import { refreshTokens, users } from '../src/db/schema.js';
import { authRateLimiter } from '../src/middlewares/rateLimiter.middleware.js';
import { hashToken } from '../src/utils/jwt.js';
import { migrateTestDb } from './helpers/db.js';

const PASSWORD = 'correct-horse-battery';

let emailCounter = 0;
const uniqueEmail = () => `user${++emailCounter}@example.com`;

const register = (body: object) => request(app).post('/api/auth/register').send(body);
const login = (body: object) => request(app).post('/api/auth/login').send(body);
const refresh = (cookie?: string) => {
  const req = request(app).post('/api/auth/refresh');
  return cookie ? req.set('Cookie', cookie) : req;
};
const logout = (cookie?: string) => {
  const req = request(app).post('/api/auth/logout');
  return cookie ? req.set('Cookie', cookie) : req;
};

// Returns the raw `refresh_token=<value>` pair from Set-Cookie, ready to send back.
function refreshCookie(res: request.Response) {
  const header = [res.headers['set-cookie'] ?? []]
    .flat()
    .find((c) => c.startsWith('refresh_token='));
  expect(header, 'expected a refresh_token Set-Cookie header').toBeDefined();
  return header!.split(';')[0]!;
}

const rawToken = (cookie: string) => cookie.slice('refresh_token='.length);

async function registerUser(overrides: object = {}) {
  const email = uniqueEmail();
  const res = await register({ email, password: PASSWORD, ...overrides });
  expect(res.status).toBe(201);
  return { email, res, cookie: refreshCookie(res) };
}

beforeAll(() => {
  migrateTestDb();
});

// authRateLimiter (10 requests / 15 min per IP) would otherwise trip mid-file.
// Supertest connects over loopback; reset both forms the limiter may key on.
const resetAuthRateLimit = () => {
  for (const ip of ['127.0.0.1', '::1']) authRateLimiter.resetKey(ipKeyGenerator(ip));
};
beforeEach(resetAuthRateLimit);

describe('POST /api/auth/register', () => {
  it('creates a customer and returns the user and an access token, never the password hash', async () => {
    const email = uniqueEmail();
    const res = await register({
      email,
      password: PASSWORD,
      firstName: 'Ada',
      lastName: 'Lovelace',
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      email,
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'customer',
    });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data).not.toHaveProperty('refreshToken');
  });

  it('sets the refresh token as an httpOnly, SameSite=Strict cookie', async () => {
    const { res } = await registerUser();
    const header = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('refresh_token='));

    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    // secure is production-only; tests run with NODE_ENV=test.
    expect(header).not.toMatch(/Secure/);
  });

  it('issues an access token that authenticates protected routes', async () => {
    const { res } = await registerUser();

    const cart = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(cart.status).toBe(200);
  });

  it('stores an argon2id hash, not the password, and only the hash of the refresh token', async () => {
    const { email, cookie } = await registerUser();

    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain(PASSWORD);

    const tokens = await db.query.refreshTokens.findMany({
      where: eq(refreshTokens.userId, user!.id),
    });
    expect(tokens.map((t) => t.tokenHash)).toEqual([hashToken(rawToken(cookie))]);
  });

  it('normalises the email to trimmed lowercase', async () => {
    const res = await register({ email: '  Mixed.Case@Example.COM ', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('mixed.case@example.com');
  });

  it('ignores a client-supplied role', async () => {
    const res = await register({ email: uniqueEmail(), password: PASSWORD, role: 'admin' });

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('customer');
  });

  it('returns 409 EMAIL_IN_USE for an existing email, regardless of case', async () => {
    const { email } = await registerUser();

    for (const variant of [email, email.toUpperCase()]) {
      const res = await register({ email: variant, password: PASSWORD });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        success: false,
        error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists' },
      });
    }
  });

  it('returns one 201 and one 409, not a 500, for simultaneous sign-ups with the same email', async () => {
    const email = uniqueEmail();
    const results = await Promise.all([
      register({ email, password: PASSWORD }),
      register({ email, password: PASSWORD }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it.each([
    ['email', { email: 'not-an-email', password: PASSWORD }],
    ['email', { password: PASSWORD }],
    ['password', { email: 'a@example.com', password: 'short' }],
    ['password', { email: 'a@example.com', password: 'x'.repeat(129) }],
    ['password', { email: 'a@example.com' }],
    ['firstName', { email: 'a@example.com', password: PASSWORD, firstName: '   ' }],
  ])('returns 400 VALIDATION_ERROR for an invalid %s', async (field, body) => {
    const res = await register(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.fieldErrors).toHaveProperty(field);
  });
});

describe('POST /api/auth/login', () => {
  let email: string;

  beforeAll(async () => {
    ({ email } = await registerUser({ firstName: 'Grace' }));
  });

  it('returns the user and an access token and sets a refresh cookie', async () => {
    const res = await login({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ email, firstName: 'Grace', role: 'customer' });
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshCookie(res)).toMatch(/^refresh_token=[0-9a-f]{96}$/);
  });

  it('accepts the email in any case and with surrounding whitespace', async () => {
    const res = await login({ email: `  ${email.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });

  it('returns an identical 401 for a wrong password and for an unknown email', async () => {
    const wrongPassword = await login({ email, password: 'wrong-password' });
    const unknownEmail = await login({ email: 'nobody@example.com', password: PASSWORD });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(wrongPassword.body).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' },
    });
  });

  it.each([
    ['email', { email: 'nope', password: PASSWORD }],
    ['password', { email: 'a@example.com', password: '' }],
    ['password', { email: 'a@example.com', password: 'x'.repeat(129) }],
  ])('returns 400 VALIDATION_ERROR for an invalid %s', async (field, body) => {
    const res = await login(body);

    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors).toHaveProperty(field);
  });

  it('gives each login its own session', async () => {
    const first = refreshCookie(await login({ email, password: PASSWORD }));
    const second = refreshCookie(await login({ email, password: PASSWORD }));

    expect(first).not.toBe(second);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the token: returns a new access token and cookie, and the old token stops working', async () => {
    const { cookie } = await registerUser();

    const res = await refresh(cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data).not.toHaveProperty('refreshToken');

    const rotated = refreshCookie(res);
    expect(rotated).not.toBe(cookie);
    expect((await refresh(rotated)).status).toBe(200);
  });

  it('issues an access token that authenticates protected routes', async () => {
    const { cookie } = await registerUser();
    const res = await refresh(cookie);

    const cart = await request(app)
      .get('/api/cart')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(cart.status).toBe(200);
  });

  it('returns 401 UNAUTHORIZED when no cookie is sent', async () => {
    const res = await refresh();

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'No refresh token provided' },
    });
  });

  it('only reads the token from the cookie, not the request body', async () => {
    const { cookie } = await registerUser();
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: rawToken(cookie) });

    expect(res.status).toBe(401);
  });

  it('returns 401 INVALID_REFRESH_TOKEN for an unknown token', async () => {
    const res = await refresh(`refresh_token=${'ab'.repeat(48)}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid or expired' },
    });
  });

  it('returns 401 INVALID_REFRESH_TOKEN for an expired token', async () => {
    const { cookie } = await registerUser();
    await db
      .update(refreshTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(refreshTokens.tokenHash, hashToken(rawToken(cookie))));

    const res = await refresh(cookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('on reuse of a rotated token, rejects it and revokes every live session for that user', async () => {
    const { email, cookie: stolen } = await registerUser();
    const otherDevice = refreshCookie(await login({ email, password: PASSWORD }));
    const rotated = refreshCookie(await refresh(stolen));

    const replay = await refresh(stolen);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_REFRESH_TOKEN');

    expect((await refresh(rotated)).status).toBe(401);
    expect((await refresh(otherDevice)).status).toBe(401);
    // A fresh login still works afterwards.
    expect((await login({ email, password: PASSWORD })).status).toBe(200);
  });

  it('never issues two new sessions for simultaneous refreshes with the same token', async () => {
    const { cookie } = await registerUser();
    const results = await Promise.all([refresh(cookie), refresh(cookie)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('is not rate limited', async () => {
    const { cookie } = await registerUser();
    let current = cookie;
    for (let i = 0; i < 12; i++) {
      const res = await refresh(current);
      expect(res.status).toBe(200);
      current = refreshCookie(res);
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const { cookie } = await registerUser();

    const res = await logout(cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { message: 'Logged out' } });

    const cleared = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('refresh_token='));
    expect(cleared).toMatch(/^refresh_token=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/HttpOnly/);
    expect(cleared).toMatch(/SameSite=Strict/);

    expect((await refresh(cookie)).status).toBe(401);
  });

  it('only ends the current session, not the user’s other sessions', async () => {
    const { email, cookie: laptop } = await registerUser();
    const phone = refreshCookie(await login({ email, password: PASSWORD }));

    await logout(laptop);
    expect((await refresh(phone)).status).toBe(200);
  });

  it('succeeds without a cookie and with an unknown token', async () => {
    expect((await logout()).status).toBe(200);
    expect((await logout(`refresh_token=${'cd'.repeat(48)}`)).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it.each([
    ['register', () => register({ email: 'rate@example.com', password: 'short' })],
    ['login', () => login({ email: 'rate@example.com', password: 'wrong' })],
  ])('limits /auth/%s to 10 requests per window per IP', async (_name, send) => {
    for (let i = 0; i < 10; i++) {
      expect((await send()).status).not.toBe(429);
    }

    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts, please try again later.' },
    });
  });

  it('shares one budget between register and login', async () => {
    for (let i = 0; i < 5; i++) await register({ email: 'rate@example.com', password: 'short' });
    for (let i = 0; i < 5; i++) await login({ email: 'rate@example.com', password: 'wrong' });

    expect((await login({ email: 'rate@example.com', password: 'wrong' })).status).toBe(429);
  });
});
