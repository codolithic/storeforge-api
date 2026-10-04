import { z } from 'zod';
import type { ZodOpenApiResponseObject, ZodOpenApiResponsesObject } from 'zod-openapi';

// Shared building blocks for the per-module `*.openapi.ts` path files. Request
// schemas are the real Zod validators from each module's `*.types.ts`; response
// schemas are documentation only, so each module pins them to its service's
// return type with `Documents<>` and a mismatch fails `npm run typecheck`.

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Compile-time check that a documented response schema matches what the
// service returns, in both directions (no missing, extra or mistyped fields):
//   type _ = Assert<Documents<typeof schema, ReturnOf<typeof service.fn>>>;
export type Documents<Schema extends z.ZodType, Actual extends z.output<Schema>> = Equals<
  z.output<Schema>,
  Actual
>;
export type Assert<T extends true> = T;

export type ReturnOf<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

export const bearerAuth = [{ bearerAuth: [] }];
export const refreshCookieAuth = [{ refreshCookie: [] }];

export const timestamp = z
  .string()
  .meta({ description: 'UTC timestamp', example: '2026-01-03 10:00:00' });

export const attributes = z
  .record(z.string(), z.string())
  .nullable()
  .meta({ description: 'Variant options', example: { color: 'Black', size: 'M' } });

const paginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: 'Pagination' });

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), pagination: paginationSchema });

// `{ success: true, data }` envelope from utils/apiResponse.ts.
export function json(description: string, data: z.ZodType): ZodOpenApiResponseObject {
  return {
    description,
    content: {
      'application/json': { schema: z.object({ success: z.literal(true), data }) },
    },
  };
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  429: 'Too many requests',
  502: 'Bad gateway',
};

// Error envelope `{ success: false, error: { code, message } }`, one response
// per status listing the exact `code` values the route can return there.
// VALIDATION_ERROR additionally carries Zod's flattened per-field `details`.
export function errors(byStatus: Record<number, [string, ...string[]]>): ZodOpenApiResponsesObject {
  const responses: ZodOpenApiResponsesObject = {};
  for (const [status, codes] of Object.entries(byStatus)) {
    const error = z.object({
      code: z.enum(codes),
      message: z.string(),
      ...(codes.includes('VALIDATION_ERROR') && {
        details: z
          .object({
            formErrors: z.array(z.string()),
            fieldErrors: z.record(z.string(), z.array(z.string())),
          })
          .optional()
          .meta({ description: 'Present for VALIDATION_ERROR only' }),
      }),
    });
    responses[status as `${1 | 2 | 3 | 4 | 5}${string}`] = {
      description: `${ERROR_DESCRIPTIONS[Number(status)] ?? 'Error'}: ${codes.join(', ')}`,
      content: {
        'application/json': { schema: z.object({ success: z.literal(false), error }) },
      },
    };
  }
  return responses;
}
