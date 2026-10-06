import { randomInt } from 'node:crypto';
import type { PaymentProvider } from './payments.types.js';

// Simulated payment gateway. It mimics the shape of a real provider client
// (async calls, provider-issued references) so the service can later be pointed
// at Stripe/PayPal SDKs without changing its flow. Outcomes are driven by the
// payment token, like a provider's test-mode tokens:
//   tok_decline        -> the charge is declined
//   tok_gateway_error  -> the provider call itself fails
//   anything else      -> the charge succeeds (so does an omitted token)
export const DECLINED_TOKEN = 'tok_decline';
export const GATEWAY_ERROR_TOKEN = 'tok_gateway_error';

export class PaymentGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

export type ChargeResult =
  | { status: 'succeeded'; providerRef: string }
  | { status: 'failed'; providerRef: string; declineReason: string };

const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const randomString = (alphabet: string, length: number) =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

// Reference formats match the seeded data: `pi_...` for Stripe, `PAYID-...` for PayPal.
function chargeRef(provider: PaymentProvider) {
  return provider === 'stripe'
    ? `pi_${randomString(LOWER, 16)}`
    : `PAYID-${randomString(UPPER, 8)}`;
}

// Refunds may target seeded payments, whose provider column is free text.
function refundRef(provider: string) {
  return provider === 'stripe'
    ? `re_${randomString(LOWER, 16)}`
    : `REFUND-${randomString(UPPER, 8)}`;
}

export async function charge(input: {
  provider: PaymentProvider;
  amount: number;
  paymentToken: string | undefined;
}): Promise<ChargeResult> {
  if (input.paymentToken === GATEWAY_ERROR_TOKEN) {
    throw new PaymentGatewayError(`${input.provider} is unavailable`);
  }
  const providerRef = chargeRef(input.provider);
  if (input.paymentToken === DECLINED_TOKEN) {
    return { status: 'failed', providerRef, declineReason: 'Your card was declined' };
  }
  return { status: 'succeeded', providerRef };
}

export async function refund(input: {
  provider: string;
  providerRef: string | null;
  amount: number;
}): Promise<{ providerRef: string }> {
  return { providerRef: refundRef(input.provider) };
}
