import type { Request, Response } from 'express';
import { sendSuccess } from '../../utils/apiResponse.js';
import * as paymentsService from './payments.service.js';
import type { ListPaymentsQuery, PaymentParams } from './payments.types.js';

// req.user is always set here: every payment route sits behind `authenticate`.

export async function listMyPayments(req: Request, res: Response): Promise<void> {
  const result = await paymentsService.listPayments(
    req.user!.id,
    res.locals.query as ListPaymentsQuery,
  );
  sendSuccess(res, result);
}

export async function getPayment(req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as PaymentParams;
  const payment = await paymentsService.getPayment(req.user!.id, id);
  sendSuccess(res, payment);
}

export async function refundPayment(_req: Request, res: Response): Promise<void> {
  const { id } = res.locals.params as PaymentParams;
  const refund = await paymentsService.refundPayment(id);
  sendSuccess(res, refund, 201);
}
