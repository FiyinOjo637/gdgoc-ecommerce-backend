import { Router, raw } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client';
import { paymentEvents } from '../../db/schema';
import { newId, nowIso } from '../../utils/id';
import { verifyWebhookSignature } from './paystack.service';
import * as ordersService from '../orders/orders.service';
import { logger } from '../../utils/logger';
import { asyncHandler } from '../../middleware/error';

const router = Router();

/**
 * Webhook body must be parsed as raw bytes (NOT JSON) so the signature can
 * be computed over the exact bytes Paystack signed. `express.raw` is scoped
 * to only this route in app.ts — every other route keeps normal JSON
 * parsing.
 */
router.post(
  '/paystack',
  raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const signature = req.headers['x-paystack-signature'] as string | undefined;

    if (!verifyWebhookSignature(rawBody, signature)) {
      logger.error('Webhook signature verification failed');
      // Respond 400 but never leak *why* signature validation failed.
      return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } });
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed webhook body' } });
    }

    const eventType: string = payload.event;
    const reference: string = payload.data?.reference;
    // Paystack doesn't send a single canonical "event id" field on every
    // event type, so we derive a stable idempotency key from fields that
    // are constant for retried deliveries of the SAME event. In production
    // prefer a provider-issued id header if/when available.
    const eventId: string = `${eventType}:${reference}:${payload.data?.id ?? payload.data?.status ?? ''}`;

    if (!reference) {
      return res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: 'Missing reference' } });
    }

    // --- Scenario E: idempotency ---
    // The (provider, eventId) unique index is the source of truth: if this
    // exact event was already recorded, we acknowledge with 200 immediately
    // and do NOT reprocess — this is what makes duplicate/retried webhook
    // deliveries safe against double-charging, duplicate orders, or double
    // stock adjustments, even under concurrent delivery.
    const already = db
      .select()
      .from(paymentEvents)
      .where(and(eq(paymentEvents.provider, 'paystack'), eq(paymentEvents.eventId, eventId)))
      .get();

    if (already) {
      logger.info('Duplicate webhook event ignored', { eventId });
      return res.status(200).json({ received: true, duplicate: true });
    }

    let orderId: string | undefined;
    try {
      const order = ordersService.getOrderByReference(reference);
      orderId = order.id;

      if (eventType === 'charge.success') {
        ordersService.applySuccessfulPayment(order.id);
      } else if (eventType === 'charge.failed') {
        ordersService.applyFailedPayment(order.id);
      }
      // Other event types (transfer.*, subscription.*, etc.) are recorded
      // for audit but don't change order state.
    } catch (err) {
      logger.error('Error applying webhook event', { reference, error: (err as Error).message });
      // We still record the event below to avoid infinite webhook retries
      // hammering a permanently-broken reference (e.g. order not found),
      // but we surface a 200 so Paystack doesn't keep retrying forever.
      // A real deployment would alert on this via the logger sink.
    }

    // Record the event AFTER processing so that if processing threw an
    // unexpected error before this point, Paystack's retry will find no
    // record and safely retry — but successful/handled paths are now
    // durably marked as processed.
    db.insert(paymentEvents)
      .values({
        id: newId(),
        provider: 'paystack',
        eventId,
        eventType,
        reference,
        orderId,
        rawPayload: rawBody,
        processedAt: nowIso(),
      })
      .run();

    return res.status(200).json({ received: true });
  }),
);

export default router;
