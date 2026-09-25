import { app, request, createUser, createProduct, authed } from './helpers';
import * as paystack from '../src/modules/payments/paystack.service';
import { db } from '../src/db/client';
import { products, orders } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { env } from '../src/config/env';
import { expireOverdueReservations } from '../src/modules/orders/orders.service';

// Only mock the network call (initializeTransaction); keep the REAL
// verifyWebhookSignature implementation, since these tests specifically
// exercise HMAC signature verification and idempotency end-to-end.
jest.mock('../src/modules/payments/paystack.service', () => {
  const actual = jest.requireActual('../src/modules/payments/paystack.service');
  return { ...actual, initializeTransaction: jest.fn() };
});
const mockedPaystack = paystack as jest.Mocked<typeof paystack>;

function signPayload(payload: object): { raw: string; signature: string } {
  const raw = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  return { raw, signature };
}

describe('EDGE CASE 1 - Concurrent stock purchase (Scenario A)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never oversells the last unit when two customers checkout at the same time', async () => {
    mockedPaystack.initializeTransaction.mockImplementation(async (params) => ({
      authorizationUrl: 'https://checkout.paystack.com/mock',
      accessCode: 'mock',
      reference: params.reference,
    }));

    const productId = createProduct({ stock: 1, priceNaira: 500 });
    const buyerA = await createUser();
    const buyerB = await createUser();

    await request(app).post('/cart/items').set(authed(buyerA.token)).send({ productId, quantity: 1 });
    await request(app).post('/cart/items').set(authed(buyerB.token)).send({ productId, quantity: 1 });

    // Fire both checkouts "simultaneously".
    const [resA, resB] = await Promise.all([
      request(app).post('/orders/checkout').set(authed(buyerA.token)),
      request(app).post('/orders/checkout').set(authed(buyerB.token)),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one succeeds (201), exactly one is rejected for insufficient
    // stock (409) - never both succeeding, never both failing.
    expect(statuses).toEqual([201, 409]);

    const product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(0); // sold exactly once, not twice, not zero times
  });

  it('sells exactly N units when N customers race for N items, and rejects the (N+1)th', async () => {
    mockedPaystack.initializeTransaction.mockImplementation(async (params) => ({
      authorizationUrl: 'https://checkout.paystack.com/mock',
      accessCode: 'mock',
      reference: params.reference,
    }));

    const productId = createProduct({ stock: 2, priceNaira: 500 });
    const buyers = await Promise.all([createUser(), createUser(), createUser()]);
    for (const b of buyers) {
      await request(app).post('/cart/items').set(authed(b.token)).send({ productId, quantity: 1 });
    }

    const results = await Promise.all(
      buyers.map((b) => request(app).post('/orders/checkout').set(authed(b.token))),
    );
    const successCount = results.filter((r) => r.status === 201).length;
    const conflictCount = results.filter((r) => r.status === 409).length;

    expect(successCount).toBe(2);
    expect(conflictCount).toBe(1);

    const product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(0);
  });
});

describe('EDGE CASE 2 - Duplicate webhook idempotency (Scenario E)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('processes a charge.success webhook once, and a byte-identical redelivery is a safe no-op', async () => {
    mockedPaystack.initializeTransaction.mockImplementation(async (params) => ({
      authorizationUrl: 'https://checkout.paystack.com/mock',
      accessCode: 'mock',
      reference: params.reference,
    }));

    const user = await createUser();
    const productId = createProduct({ stock: 3, priceNaira: 1000 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 1 });
    const checkoutRes = await request(app).post('/orders/checkout').set(authed(user.token));
    expect(checkoutRes.status).toBe(201);
    const reference = checkoutRes.body.order.reference;

    const webhookPayload = {
      event: 'charge.success',
      data: { reference, id: 999888, status: 'success', amount: 100000 },
    };
    const { raw, signature } = signPayload(webhookPayload);

    // First delivery: processes normally, order becomes PAID.
    const first = await request(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(first.status).toBe(200);
    expect(first.body.duplicate).toBeUndefined();

    let order = db.select().from(orders).where(eq(orders.reference, reference)).get()!;
    expect(order.status).toBe('PAID');

    // Second, IDENTICAL delivery (webhook providers retry on any non-2xx,
    // network blip, or timeout - this must be a no-op, not a second charge
    // application or a crash).
    const second = await request(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    order = db.select().from(orders).where(eq(orders.reference, reference)).get()!;
    expect(order.status).toBe('PAID'); // unchanged, not double-processed

    // Stock was decremented exactly once at checkout time, and committing
    // a reservation doesn't touch stock again - confirm no double debit.
    const product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(2); // 3 - 1, not 3 - 2
  });

  it('rejects a webhook with an invalid/forged signature', async () => {
    const payload = { event: 'charge.success', data: { reference: 'FAKE-REF', id: 1 } };
    const raw = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', 'not-a-real-signature')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });
});

describe('EDGE CASE 3 - Expired stock reservations are reclaimed (Scenario F)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('releases stock for an order whose reservation TTL has passed, and a late payment cannot resurrect it', async () => {
    mockedPaystack.initializeTransaction.mockImplementation(async (params) => ({
      authorizationUrl: 'https://checkout.paystack.com/mock',
      accessCode: 'mock',
      reference: params.reference,
    }));

    const user = await createUser();
    const productId = createProduct({ stock: 5, priceNaira: 1000 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 2 });
    const checkoutRes = await request(app).post('/orders/checkout').set(authed(user.token));
    const orderId = checkoutRes.body.order.id;
    const reference = checkoutRes.body.order.reference;

    let product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(3); // 5 - 2 reserved

    // Simulate the reservation TTL having already passed (instead of
    // waiting real minutes, we backdate reservationExpiresAt directly -
    // the sweep logic itself is exercised unmodified).
    db.update(orders)
      .set({ reservationExpiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(eq(orders.id, orderId))
      .run();

    const expiredCount = expireOverdueReservations();
    expect(expiredCount).toBe(1);

    product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(5); // fully reclaimed

    const order = db.select().from(orders).where(eq(orders.id, orderId)).get()!;
    expect(order.status).toBe('EXPIRED');

    // A payment that arrives AFTER expiry (e.g. customer completed payment
    // on a stale checkout tab right as the TTL lapsed) must not silently
    // flip the order back to PAID and re-commit a reservation that no
    // longer reflects real inventory - it must be flagged, not applied.
    const webhookPayload = {
      event: 'charge.success',
      data: { reference, id: 42424, status: 'success', amount: 200000 },
    };
    const { raw, signature } = signPayload(webhookPayload);
    const res = await request(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', signature)
      .set('Content-Type', 'application/json')
      .send(raw);

    // The webhook handler catches and logs this rather than 500ing (so
    // Paystack doesn't retry-storm), but the order must remain EXPIRED.
    expect(res.status).toBe(200);
    const finalOrder = db.select().from(orders).where(eq(orders.id, orderId)).get()!;
    expect(finalOrder.status).toBe('EXPIRED');

    const finalProduct = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(finalProduct.stock).toBe(5); // still not double-deducted
  });
});
