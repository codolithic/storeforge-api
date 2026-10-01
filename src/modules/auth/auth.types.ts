import { z } from 'zod';

// Normalised before validation so "Jane@X.com " and "jane@x.com" are the same account.
const email = z.string().trim().toLowerCase().pipe(z.email());

// argon2 has no input limit, so cap length to bound hashing cost per request.
const MAX_PASSWORD_LENGTH = 128;

export const registerSchema = z.object({
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
