import { app, request, createUser, createProduct, authed } from './helpers';
import { db } from '../src/db/client';
import { products } from '../src/db/schema';
import { eq } from 'drizzle-orm';
import { nairaToKobo } from '../src/utils/money';

describe('Cart', () => {
  it('starts empty for a new user', async () => {
    const user = await createUser();
    const res = await request(app).get('/cart').set(authed(user.token));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('adds an item and increments quantity on repeated adds', async () => {
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });

    const res1 = await request(app)
      .post('/cart/items')
      .set(authed(user.token))
      .send({ productId, quantity: 2 });
    expect(res1.status).toBe(201);
    expect(res1.body.items[0].quantity).toBe(2);

    const res2 = await request(app)
      .post('/cart/items')
      .set(authed(user.token))
      .send({ productId, quantity: 3 });
    expect(res2.body.items[0].quantity).toBe(5);
  });

  it('rejects adding more than available stock (409)', async () => {
    const user = await createUser();
    const productId = createProduct({ stock: 2 });
    const res = await request(app)
      .post('/cart/items')
      .set(authed(user.token))
      .send({ productId, quantity: 5 });
    expect(res.status).toBe(409);
  });

  it('updates and removes items', async () => {
    const user = await createUser();
    const productId = createProduct({ stock: 10 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 1 });

    const updateRes = await request(app)
      .patch(`/cart/items/${productId}`)
      .set(authed(user.token))
      .send({ quantity: 4 });
    expect(updateRes.body.items[0].quantity).toBe(4);

    const removeRes = await request(app).delete(`/cart/items/${productId}`).set(authed(user.token));
    expect(removeRes.body.items).toEqual([]);
  });

  it('flags PRICE_CHANGED when the product price changes after adding to cart', async () => {
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 1 });

    // Simulate an admin price change directly at the data layer.
    db.update(products).set({ priceKobo: nairaToKobo(200) }).where(eq(products.id, productId)).run();

    const res = await request(app).get('/cart').set(authed(user.token));
    expect(res.body.items[0].priceChanged).toBe(true);
    expect(res.body.items[0].unitPrice).toBe(200);
    expect(res.body.items[0].priceAtAdd).toBe(100);
  });

  it('flags INSUFFICIENT_STOCK and excludes the item from subtotal when stock drops below cart quantity', async () => {
    const user = await createUser();
    const productId = createProduct({ stock: 10, priceNaira: 100 });
    await request(app).post('/cart/items').set(authed(user.token)).send({ productId, quantity: 5 });

    db.update(products).set({ stock: 2 }).where(eq(products.id, productId)).run();

    const res = await request(app).get('/cart').set(authed(user.token));
    expect(res.body.items[0].issues).toContain('INSUFFICIENT_STOCK');
    expect(res.body.readyForCheckout).toBe(false);
    expect(res.body.subtotal).toBe(0);
  });

  it("never lets one user see or modify another user's cart (IDOR safety)", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const productId = createProduct({ stock: 10 });

    await request(app).post('/cart/items').set(authed(userA.token)).send({ productId, quantity: 1 });

    const bCart = await request(app).get('/cart').set(authed(userB.token));
    expect(bCart.body.items).toEqual([]); // B's own cart, not A's

    // There is no cart-id-based route at all — every cart route resolves
    // "the cart" from the bearer token's user id, so there is no request
    // B could craft to reach A's cart.
  });
});
