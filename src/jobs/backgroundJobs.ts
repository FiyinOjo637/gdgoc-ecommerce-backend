import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { orders } from '../db/schema';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { expireOverdueReservations, verifyOrderWithGateway } from '../modules/orders/orders.service';

let reservationTimer: NodeJS.Timeout | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;

/**
 * Scenario F: periodically releases stock for orders whose reservation TTL
 * has passed without a successful payment, so inventory isn't held hostage
 * by abandoned checkouts forever.
 */
function runReservationExpirySweep() {
  try {
    const count = expireOverdueReservations();
    if (count > 0) logger.info(`Reservation sweep expired ${count} order(s)`);
  } catch (err) {
    logger.error('Reservation expiry sweep failed', { error: (err as Error).message });
  }
}

/**
 * Scenario D: catches "abandoned browser" cases where the customer paid but
 * never returned to the site, and/or the webhook delivery was lost, by
 * actively polling the gateway for any order that's been PENDING_PAYMENT
 * for a while. This is a safety net alongside (not a replacement for) the
 * webhook, since webhooks can be delayed, dropped, or (rarely) never sent.
 */
async function runReconciliationSweep() {
  try {
    const staleThreshold = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const pending = db
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'PENDING_PAYMENT'), sql`${orders.createdAt} <= ${staleThreshold}`))
      .all();

    for (const order of pending) {
      try {
        // System-initiated reconciliation acts with admin-equivalent
        // authority since there's no request-scoped user here.
        await verifyOrderWithGateway(order.userId, order.id, true);
      } catch (err) {
        logger.error('Reconciliation check failed for order', {
          orderId: order.id,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.error('Reconciliation sweep failed', { error: (err as Error).message });
  }
}

export function startBackgroundJobs() {
  if (reservationTimer || reconciliationTimer) return; // already started
  reservationTimer = setInterval(runReservationExpirySweep, env.RECONCILIATION_POLL_INTERVAL_MS);
  reconciliationTimer = setInterval(runReconciliationSweep, env.RECONCILIATION_POLL_INTERVAL_MS);
  logger.info('Background jobs started', {
    intervalMs: env.RECONCILIATION_POLL_INTERVAL_MS,
  });
}

export function stopBackgroundJobs() {
  if (reservationTimer) clearInterval(reservationTimer);
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reservationTimer = null;
  reconciliationTimer = null;
}

// Exported individually so tests can invoke a single sweep deterministically
// instead of waiting on real timers.
export const _internal = { runReservationExpirySweep, runReconciliationSweep };
