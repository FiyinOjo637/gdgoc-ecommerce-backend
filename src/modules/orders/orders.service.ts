import { and, eq, sql } from 'drizzle-orm';
import { db, sqlite } from '../../db/client';
import { orders, orderItems, stockReservations, products, cartItems } from '../../db/schema';
import { newId, newOrderReference, nowIso } from '../../utils/id';
import { koboToNaira } from '../../utils/money';
import { env } from '../../config/env';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../utils/errors';
import { requireNonEmptyCartRow, restoreCartItems } from '../cart/cart.service';
import * as paystack from '../payments/paystack.service';
import { logger } from '../../utils/logger';

function serializeOrder(order: typeof orders.$inferSelect, items: (typeof orderItems.$inferSelect)[]) {
  return {
    id: order.id,
    status: order.status,
    reference: order.reference,
    total: koboToNaira(order.totalKobo),
    reservationExpiresAt: order.reservationExpiresAt,
    items: items.map((i) => ({
      productId: i.productId,
      name: i.productNameSnapshot,
      unitPrice: koboToNaira(i.unitPriceKobo),
      quantity: i.quantity,
      subtotal: koboToNaira(i.subtotalKobo),
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

interface CheckoutResult {
  order: ReturnType<typeof serializeOrder>;
  payment: { authorizationUrl: string; accessCode: string; reference: string };
}

/**
 * Runs the fully-atomic part of checkout: for every cart line, atomically
 * decrement product stock with a conditional UPDATE (`WHERE stock >= qty`)
 * so two concurrent checkouts can never both succeed against the same last
 * unit (Scenario A) - this is safe under Postgres with multiple app
 * instances too, unlike relying on an app-level mutex. Uses the LIVE
 * product price, never the cart's priceAtAdd snapshot (Scenario B). All
 * writes (stock decrement, order, order items, reservations, cart clear)
 * happen in one DB transaction, so a failure partway through leaves no
 * partial state (first half of Scenario C).
 */
function runAtomicCheckoutTransaction(userId: string, email: string): typeof orders.$inferSelect {
  const { cart, rows } = requireNonEmptyCartRow(userId);

  const reference = newOrderReference();
  const now = nowIso();
  const orderId = newId();
  const reservationExpiresAt = new Date(
    Date.now() + env.RESERVATION_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  const txResult = db.transaction((tx) => {
    let totalKobo = 0;
    const itemsToInsert: (typeof orderItems.$inferInsert)[] = [];
    const reservationsToInsert: (typeof stockReservations.$inferInsert)[] = [];

    for (const cartRow of rows) {
      const product = tx.select().from(products).where(eq(products.id, cartRow.productId)).get();
      if (!product || !product.isActive) {
        throw new ConflictError(`A product in your cart is no longer available`, {
          productId: cartRow.productId,
        });
      }

      // --- Scenario A: atomic conditional stock decrement ---
      // This single UPDATE is the entire concurrency-safety mechanism: the
      // WHERE clause re-checks stock >= quantity at the moment of the write,
      // inside SQLite's transaction lock, so if two requests race for the
      // last unit, only one UPDATE affects a row - the other affects zero
      // rows and we abort that whole transaction.
      const updateResult = tx
        .update(products)
        .set({ stock: sql`${products.stock} - ${cartRow.quantity}`, version: sql`${products.version} + 1` })
        .where(and(eq(products.id, product.id), sql`${products.stock} >= ${cartRow.quantity}`))
        .run();

      if (updateResult.changes === 0) {
        throw new ConflictError(
          `Insufficient stock for "${product.name}" - someone may have just purchased it`,
          { productId: product.id },
        );
      }

      // Scenario B: always price at the LIVE product price read just above,
      // never the cart's priceAtAdd snapshot.
      const unitPriceKobo = product.priceKobo;
      const subtotalKobo = unitPriceKobo * cartRow.quantity;
      totalKobo += subtotalKobo;

      itemsToInsert.push({
        id: newId(),
        orderId,
        productId: product.id,
        productNameSnapshot: product.name,
        unitPriceKobo,
        quantity: cartRow.quantity,
        subtotalKobo,
      });
      reservationsToInsert.push({
        id: newId(),
        orderId,
        productId: product.id,
        quantity: cartRow.quantity,
        status: 'ACTIVE',
        expiresAt: reservationExpiresAt,
        createdAt: now,
      });
    }

    tx.insert(orders)
      .values({
        id: orderId,
        userId,
        status: 'PENDING_PAYMENT',
        totalKobo,
        reference,
        reservationExpiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    tx.insert(orderItems).values(itemsToInsert).run();
    tx.insert(stockReservations).values(reservationsToInsert).run();

    // Cart is cleared as part of the SAME transaction that reserved the
    // stock, so a crash between "decrement stock" and "clear cart" is
    // impossible - either both happened or neither did.
    tx.delete(cartItems).where(eq(cartItems.cartId, cart.id)).run();

    return tx.select().from(orders).where(eq(orders.id, orderId)).get()!;
  });

  return txResult;
}

/**
 * Full checkout flow, including the non-atomic external payment-gateway
 * call and its compensating rollback (Scenario C, second half).
 */
export async function checkout(userId: string, email: string): Promise<CheckoutResult> {
  const order = runAtomicCheckoutTransaction(userId, email);
  const items = db.select().from(orderItems).where(eq(orderItems.orderId, order.id)).all();

  try {
    const payment = await paystack.initializeTransaction({
      email,
      amountKobo: order.totalKobo,
      reference: order.reference,
      metadata: { orderId: order.id, userId },
    });
    return { order: serializeOrder(order, items), payment };
  } catch (err) {
    // --- Scenario C: compensating rollback for the non-transactional step ---
    // The DB transaction above already committed (order + reservation +
    // cart clear). Since we can't roll that back after the fact, we
    // explicitly release the reservation and restore stock, then mark the
    // order FAILED, in a second transaction - leaving the system
    // consistent even though the two steps aren't one atomic unit.
    logger.error('Payment initialization failed after order creation; compensating', {
      orderId: order.id,
      error: (err as Error).message,
    });
    releaseOrderReservations(order.id, 'FAILED');
    restoreCartItems(
      userId,
      items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
    );
    throw err;
  }
}

function releaseOrderReservations(orderId: string, finalStatus: 'FAILED' | 'EXPIRED' | 'CANCELLED') {
  db.transaction((tx) => {
    const activeReservations = tx
      .select()
      .from(stockReservations)
      .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, 'ACTIVE')))
      .all();

    for (const res of activeReservations) {
      tx.update(products)
        .set({ stock: sql`${products.stock} + ${res.quantity}`, version: sql`${products.version} + 1` })
        .where(eq(products.id, res.productId))
        .run();
      tx.update(stockReservations)
        .set({ status: 'RELEASED' })
        .where(eq(stockReservations.id, res.id))
        .run();
    }

    tx.update(orders)
      .set({ status: finalStatus, updatedAt: nowIso() })
      .where(eq(orders.id, orderId))
      .run();
  });
}

function commitOrderReservations(orderId: string) {
  db.transaction((tx) => {
    tx.update(stockReservations)
      .set({ status: 'COMMITTED' })
      .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.status, 'ACTIVE')))
      .run();
    tx.update(orders)
      .set({ status: 'PAID', updatedAt: nowIso() })
      .where(eq(orders.id, orderId))
      .run();
  });
}

/**
 * Applies a confirmed-successful payment to an order, idempotently: if the
 * order is already PAID (e.g. this is a duplicate webhook that slipped past
 * the PaymentEvent uniqueness check, or a race between webhook and poll),
 * this is a safe no-op (Scenario E, defence in depth).
 */
export function applySuccessfulPayment(orderId: string) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError('Order not found');
  if (order.status === 'PAID') return serializeOrderFull(order.id);
  if (order.status !== 'PENDING_PAYMENT') {
    // Order already terminally FAILED/EXPIRED/CANCELLED but a late payment
    // came in - flag loudly for manual reconciliation rather than silently
    // re-committing stock that was already given back to the pool.
    logger.error('Payment succeeded for a non-pending order', { orderId, status: order.status });
    throw new ConflictError(`Order ${orderId} is ${order.status}, cannot mark PAID`);
  }
  commitOrderReservations(orderId);
  return serializeOrderFull(orderId);
}

export function applyFailedPayment(orderId: string) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError('Order not found');
  if (order.status !== 'PENDING_PAYMENT') return serializeOrderFull(orderId);
  releaseOrderReservations(orderId, 'FAILED');
  return serializeOrderFull(orderId);
}

/**
 * Background job target (Scenario F): releases reservations - and restores
 * stock - for any order still PENDING_PAYMENT past its reservation TTL.
 * Returns the number of orders expired, for logging/metrics.
 */
export function expireOverdueReservations(): number {
  const nowStr = nowIso();
  const overdue = db
    .select()
    .from(orders)
    .where(and(eq(orders.status, 'PENDING_PAYMENT'), sql`${orders.reservationExpiresAt} <= ${nowStr}`))
    .all();

  for (const order of overdue) {
    releaseOrderReservations(order.id, 'EXPIRED');
    logger.info('Expired stale order reservation', { orderId: order.id, reference: order.reference });
  }
  return overdue.length;
}

function serializeOrderFull(orderId: string) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get()!;
  const items = db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).all();
  return serializeOrder(order, items);
}

export function getOrderForUser(userId: string, orderId: string, isAdmin: boolean) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError('Order not found');
  // IDOR guard: a customer may only read their own order; admins may read any.
  if (!isAdmin && order.userId !== userId) throw new ForbiddenError('Not your order');
  const items = db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).all();
  return serializeOrder(order, items);
}

export function listOrdersForUser(userId: string) {
  const rows = db.select().from(orders).where(eq(orders.userId, userId)).all();
  return rows.map((o) => serializeOrderFull(o.id));
}

export function getOrderByReference(reference: string) {
  const order = db.select().from(orders).where(eq(orders.reference, reference)).get();
  if (!order) throw new NotFoundError('Order not found for reference');
  return order;
}

/**
 * Manual/poll reconciliation path (Scenario D): asks the gateway directly
 * for the transaction status, for cases where the browser was abandoned
 * and no webhook has (yet) arrived. Safe to call repeatedly - idempotent
 * via the same PENDING_PAYMENT-only guards as the webhook path.
 */
export async function verifyOrderWithGateway(userId: string, orderId: string, isAdmin: boolean) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError('Order not found');
  if (!isAdmin && order.userId !== userId) throw new ForbiddenError('Not your order');
  if (order.status !== 'PENDING_PAYMENT') return serializeOrderFull(order.id);

  const result = await paystack.verifyTransaction(order.reference);
  if (result.status === 'success') {
    applySuccessfulPayment(order.id);
  } else if (result.status === 'failed' || result.status === 'abandoned') {
    applyFailedPayment(order.id);
  }
  return serializeOrderFull(order.id);
}

export function cancelOrder(userId: string, orderId: string, isAdmin: boolean) {
  const order = db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw new NotFoundError('Order not found');
  if (!isAdmin && order.userId !== userId) throw new ForbiddenError('Not your order');
  if (order.status !== 'PENDING_PAYMENT') {
    throw new BadRequestError(`Cannot cancel an order in status ${order.status}`);
  }
  releaseOrderReservations(orderId, 'CANCELLED');
  return serializeOrderFull(orderId);
}

// re-exported for the reconciliation job
export { sqlite as _sqliteHandleForJobs };
