import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { carts, cartItems, products } from '../../db/schema';
import { newId, nowIso } from '../../utils/id';
import { koboToNaira } from '../../utils/money';
import { BadRequestError, ConflictError, NotFoundError } from '../../utils/errors';

/**
 * Every function here takes `userId` from the authenticated request
 * (never a client-supplied cart id) and looks up "the current user's cart".
 * This is the IDOR boundary for carts: there is structurally no way to
 * fetch or mutate another tenant's cart through these functions.
 */
function getOrCreateCart(userId: string) {
  let cart = db.select().from(carts).where(eq(carts.userId, userId)).get();
  if (!cart) {
    const now = nowIso();
    const id = newId();
    db.insert(carts).values({ id, userId, createdAt: now, updatedAt: now }).run();
    cart = db.select().from(carts).where(eq(carts.id, id)).get()!;
  }
  return cart;
}

function fetchActiveProduct(productId: string) {
  const product = db.select().from(products).where(eq(products.id, productId)).get();
  if (!product || !product.isActive) {
    throw new NotFoundError('Product not found or no longer available');
  }
  return product;
}

/**
 * Builds the cart view with LIVE product data joined in, and flags any item
 * whose price has drifted since it was added, or whose quantity now exceeds
 * available stock, or that has been deactivated/removed from the catalog.
 * This is how Scenario B (dynamic price changes) and general "dynamic
 * catalog changes" are surfaced to the client before checkout - without
 * ever mutating the cart automatically out from under the user.
 */
export function getCartView(userId: string) {
  const cart = getOrCreateCart(userId);
  const rows = db
    .select({ item: cartItems, product: products })
    .from(cartItems)
    .innerJoin(products, eq(cartItems.productId, products.id))
    .where(eq(cartItems.cartId, cart.id))
    .all();

  let subtotalKobo = 0;
  let hasBlockingIssue = false;

  const items = rows.map(({ item, product }) => {
    const priceChanged = product.priceKobo !== item.priceAtAddKobo;
    const unavailable = !product.isActive;
    const insufficientStock = product.stock < item.quantity;
    if (unavailable || insufficientStock) hasBlockingIssue = true;

    const lineTotalKobo = product.priceKobo * item.quantity;
    if (!unavailable && !insufficientStock) subtotalKobo += lineTotalKobo;

    return {
      productId: product.id,
      name: product.name,
      quantity: item.quantity,
      unitPrice: koboToNaira(product.priceKobo),
      priceAtAdd: koboToNaira(item.priceAtAddKobo),
      priceChanged,
      lineTotal: koboToNaira(lineTotalKobo),
      availableStock: product.stock,
      isActive: product.isActive,
      issues: [
        ...(unavailable ? ['PRODUCT_UNAVAILABLE'] : []),
        ...(insufficientStock ? ['INSUFFICIENT_STOCK'] : []),
        ...(priceChanged ? ['PRICE_CHANGED'] : []),
      ],
    };
  });

  return {
    cartId: cart.id,
    items,
    itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
    subtotal: koboToNaira(subtotalKobo),
    readyForCheckout: items.length > 0 && !hasBlockingIssue,
  };
}

export function addItem(userId: string, productId: string, quantity: number) {
  const cart = getOrCreateCart(userId);
  const product = fetchActiveProduct(productId);

  const existing = db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)))
    .get();

  const newQuantity = (existing?.quantity ?? 0) + quantity;
  if (newQuantity > product.stock) {
    throw new ConflictError(
      `Only ${product.stock} unit(s) of "${product.name}" available`,
      { available: product.stock, requested: newQuantity },
    );
  }

  const now = nowIso();
  if (existing) {
    db.update(cartItems)
      .set({ quantity: newQuantity, priceAtAddKobo: product.priceKobo, updatedAt: now })
      .where(eq(cartItems.id, existing.id))
      .run();
  } else {
    db.insert(cartItems)
      .values({
        id: newId(),
        cartId: cart.id,
        productId,
        quantity,
        priceAtAddKobo: product.priceKobo,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  db.update(carts).set({ updatedAt: now }).where(eq(carts.id, cart.id)).run();

  return getCartView(userId);
}

export function updateItemQuantity(userId: string, productId: string, quantity: number) {
  const cart = getOrCreateCart(userId);
  const product = fetchActiveProduct(productId);
  const existing = db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)))
    .get();
  if (!existing) throw new NotFoundError('Item not in cart');

  if (quantity > product.stock) {
    throw new ConflictError(`Only ${product.stock} unit(s) of "${product.name}" available`, {
      available: product.stock,
      requested: quantity,
    });
  }

  db.update(cartItems)
    .set({ quantity, priceAtAddKobo: product.priceKobo, updatedAt: nowIso() })
    .where(eq(cartItems.id, existing.id))
    .run();

  return getCartView(userId);
}

export function removeItem(userId: string, productId: string) {
  const cart = getOrCreateCart(userId);
  const existing = db
    .select()
    .from(cartItems)
    .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, productId)))
    .get();
  if (!existing) throw new NotFoundError('Item not in cart');

  db.delete(cartItems).where(eq(cartItems.id, existing.id)).run();
  return getCartView(userId);
}

export function clearCart(userId: string) {
  const cart = getOrCreateCart(userId);
  db.delete(cartItems).where(eq(cartItems.cartId, cart.id)).run();
  return getCartView(userId);
}

/** Used internally by the checkout service - throws if the cart is empty. */
export function requireNonEmptyCartRow(userId: string) {
  const cart = getOrCreateCart(userId);
  const rows = db.select().from(cartItems).where(eq(cartItems.cartId, cart.id)).all();
  if (rows.length === 0) throw new BadRequestError('Cart is empty');
  return { cart, rows };
}

/**
 * Used by the checkout compensating-rollback path (Scenario C): when the
 * DB transaction (stock decrement + order + cart clear) has already
 * committed but the subsequent payment-gateway call fails, we release the
 * stock reservation AND put the same line items back in the customer's
 * cart, so "checkout failed, please try again" is actually retryable
 * instead of silently discarding what they were buying. Re-reads the
 * CURRENT product price for the snapshot (the original price at the time
 * of the failed attempt may itself be stale).
 */
export function restoreCartItems(userId: string, items: { productId: string; quantity: number }[]) {
  const cart = getOrCreateCart(userId);
  const now = nowIso();
  for (const item of items) {
    const product = db.select().from(products).where(eq(products.id, item.productId)).get();
    if (!product || !product.isActive) continue; // can't restore a product that's now gone
    const existing = db
      .select()
      .from(cartItems)
      .where(and(eq(cartItems.cartId, cart.id), eq(cartItems.productId, item.productId)))
      .get();
    if (existing) continue; // don't clobber items the user has since re-added themselves
    db.insert(cartItems)
      .values({
        id: newId(),
        cartId: cart.id,
        productId: item.productId,
        quantity: item.quantity,
        priceAtAddKobo: product.priceKobo,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}
