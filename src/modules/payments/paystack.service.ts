import axios from 'axios';
import crypto from 'crypto';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { UnprocessableError } from '../../utils/errors';

const client = axios.create({
  baseURL: env.PAYSTACK_BASE_URL,
  headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  timeout: 10000,
});

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyResult {
  reference: string;
  status: 'success' | 'failed' | 'abandoned' | string;
  amountKobo: number;
  paidAt: string | null;
  channel: string | null;
  gatewayResponse: string | null;
}

/**
 * Initializes a Paystack transaction for the given order. This is the
 * external, non-transactional call referenced in DESIGN.md Scenario C: it
 * happens AFTER the local DB transaction (order + stock reservation +
 * cart clear) has already committed, so a failure here triggers an
 * explicit compensating rollback rather than relying on DB rollback.
 */
export async function initializeTransaction(params: {
  email: string;
  amountKobo: number;
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<InitializeResult> {
  try {
    const { data } = await client.post('/transaction/initialize', {
      email: params.email,
      amount: params.amountKobo, // Paystack expects the smallest currency unit
      reference: params.reference,
      callback_url: env.FRONTEND_CALLBACK_URL,
      metadata: params.metadata ?? {},
    });
    if (!data?.status) {
      throw new UnprocessableError('Payment gateway rejected the transaction', data);
    }
    return {
      authorizationUrl: data.data.authorization_url,
      accessCode: data.data.access_code,
      reference: data.data.reference,
    };
  } catch (err) {
    logger.error('Paystack initialize failed', { error: (err as Error).message });
    throw new UnprocessableError('Could not initialize payment with the gateway');
  }
}

/** Used both by the manual "verify" endpoint and the reconciliation poll job (Scenario D). */
export async function verifyTransaction(reference: string): Promise<VerifyResult> {
  try {
    const { data } = await client.get(`/transaction/verify/${encodeURIComponent(reference)}`);
    const d = data.data;
    return {
      reference: d.reference,
      status: d.status,
      amountKobo: d.amount,
      paidAt: d.paid_at ?? null,
      channel: d.channel ?? null,
      gatewayResponse: d.gateway_response ?? null,
    };
  } catch (err) {
    logger.error('Paystack verify failed', { reference, error: (err as Error).message });
    throw new UnprocessableError('Could not verify transaction with the gateway');
  }
}

/**
 * Verifies the `x-paystack-signature` header: HMAC-SHA512 of the raw request
 * body, keyed with the secret key. This MUST run against the raw request
 * bytes (see app.ts, which captures req.rawBody for this route only) -
 * verifying against a re-serialized JSON object is a common bug that breaks
 * signature verification silently.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader?: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  // Constant-time comparison to avoid timing side-channels.
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
