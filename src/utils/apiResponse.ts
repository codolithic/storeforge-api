import type { Response } from 'express';

// Consistent response envelope across every endpoint.
export const sendSuccess = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ success: true, data });
};

export const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ success: false, error: { code, message } });
};
