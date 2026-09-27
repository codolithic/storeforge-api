import argon2 from 'argon2';

// argon2id is the current industry-recommended password hashing algorithm
// (winner of the Password Hashing Competition, recommended by OWASP).
export const hashPassword = (plain: string): Promise<string> =>
  argon2.hash(plain, { type: argon2.argon2id });

export const verifyPassword = (hash: string, plain: string): Promise<boolean> =>
  argon2.verify(hash, plain);
