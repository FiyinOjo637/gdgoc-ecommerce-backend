import { app, request, createUser, createProduct, authed } from './helpers';
import * as paystack from '../src/modules/payments/paystack.service';
import { db } from '../src/db/client';
import { products } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { UnprocessableError } from '../src/utils/errors';

jest.mock('../src/modules/payments/paystack.service');
const mockedPaystack = paystack as jest.Mocked<typeof paystack>;

function mockPaystackSuccess() {
  mockedPaystack.initializeTransaction.mockResolvedValue({
    authorizationUrl: 'https://checkout.paystack.com/mock',
    accessCode: 'mock_access_code',
    reference: 'mock-ref',
  });
}

function mockPaystackFailure() {
  // Mirrors what the real paystack.service throws on a gateway error, since
  // jest.mock() replaces the whole module (the real try/catch-and-wrap
  // logic inside initializeTransaction is not running here).
  mockedPaystack.initializeTransaction.mockRejectedValue(
    new UnprocessableError('Could not initialize payment with the gateway'),
  );
}

describe('Checkout / Orders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects checkout with an empty cart', async () => {
    const user = await createUser();
    const res = await request(app).post('/orders/checkout').set(authed(user.token));
    expect(res.status).toBe(400);
  });

  it('creates a PENDING_PAYMENT order, decrements stock, clears cart, and returns a payment link', async () => {
    mockPaystackSuccess();
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 3 });

    const res = await request(app).post('/orders/checkout').set(authed(user.token));
    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('PENDING_PAYMENT');
    expect(res.body.order.total).toBe(300);
    expect(res.body.payment.authorizationUrl).toContain('paystack');

    const product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(7); // 10 - 3

    const cartRes = await request(app).get('/cart').set(authed(user.token));
    expect(cartRes.body.items).toEqual([]);
  });

  it('uses the LIVE product price at checkout, not the cart snapshot price (Scenario B)', async () => {
    mockPaystackSuccess();
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 2 });

    // Price changes AFTER the item was added to the cart, before checkout.
    db.update(products).set({ priceKobo: 20000 }).where(eq(products.id, productId)).run(); // 200 naira

    const res = await request(app).post('/orders/checkout').set(authed(user.token));
    expect(res.status).toBe(201);
    expect(res.body.order.items[0].unitPrice).toBe(200); // live price, not the 100 snapshot
    expect(res.body.order.total).toBe(400); // 2 * 200, not 2 * 100
  });

  it('rolls back the transaction and restores the cart when payment init fails (Scenario C)', async () => {
    mockPaystackFailure();
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 4 });

    const res = await request(app).post('/orders/checkout').set(authed(user.token));
    expect(res.status).toBe(422);

    // Stock must be restored - no phantom deduction from a failed checkout.
    const product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(10);

    // Cart must be restored so the customer can simply retry.
    const cartRes = await request(app).get('/cart').set(authed(user.token));
    expect(cartRes.body.items).toHaveLength(1);
    expect(cartRes.body.items[0].quantity).toBe(4);
  });

  it("prevents a customer from reading another customer's order (IDOR)", async () => {
    mockPaystackSuccess();
    const owner = await createUser();
    const intruder = await createUser();
    const productId = createProduct({ stock: 10 });
    await request(app).post('/cart/items').set(authed(owner.token)).send({ productId, quantity: 1 });
    const checkoutRes = await request(app).post('/orders/checkout').set(authed(owner.token));
    const orderId = checkoutRes.body.order.id;

    const res = await request(app).get(`/orders/${orderId}`).set(authed(intruder.token));
    expect(res.status).toBe(403);
  });

  it('allows an admin to read any order', async () => {
    mockPaystackSuccess();
    const owner = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    const productId = createProduct({ stock: 10 });
    await request(app).post('/cart/items').set(authed(owner.token)).send({ productId, quantity: 1 });
    const checkoutRes = await request(app).post('/orders/checkout').set(authed(owner.token));
    const orderId = checkoutRes.body.order.id;

    const res = await request(app).get(`/orders/${orderId}`).set(authed(admin.token));
    expect(res.status).toBe(200);
  });

  it('lets a customer cancel their own pending order, releasing stock', async () => {
    mockPaystackSuccess();
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 5 });
    const checkoutRes = await request(app).post('/orders/checkout').set(authed(user.token));
    const orderId = checkoutRes.body.order.id;

    let product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(5);

    const cancelRes = await request(app).post(`/orders/${orderId}/cancel`).set(authed(user.token));
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe('CANCELLED');

    product = db.select().from(products).where(eq(products.id, productId)).get()!;
    expect(product.stock).toBe(10);
  });
});
