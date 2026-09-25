import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Data model for the mini e-commerce backend.
 *
 * Money is stored as INTEGER minor units ("kobo"/cents) everywhere, never as
 * a float, to avoid rounding errors in totals and to stay portable to a
 * DECIMAL column in Postgres later (see DESIGN.md "Database & portability").
 *
 * Timestamps are stored as ISO-8601 text, set explicitly by the application
 * (never relying on DB-side NOW()), so behaviour is identical under SQLite
 * and Postgres and trivially mockable in tests.
 */

export const roleEnum = ['CUSTOMER', 'ADMIN'] as const;
export type Role = (typeof roleEnum)[number];

export const orderStatusEnum = [
  'PENDING_PAYMENT',
  'PAID',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof orderStatusEnum)[number];

export const reservationStatusEnum = ['ACTIVE', 'COMMITTED', 'RELEASED'] as const;
export type ReservationStatus = (typeof reservationStatusEnum)[number];

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: roleEnum }).notNull().default('CUSTOMER'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
  }),
);

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    priceKobo: integer('price_kobo').notNull(),
    stock: integer('stock').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    imageUrl: text('image_url'),
    // Optimistic-concurrency guard, incremented on every update. Used as a
    // defensive secondary check alongside the atomic conditional-update
    // decrement described in DESIGN.md Scenario A.
    version: integer('version').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    categoryIdx: index('products_category_idx').on(t.category),
    activeIdx: index('products_active_idx').on(t.isActive),
    nameIdx: index('products_name_idx').on(t.name),
  }),
);

export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    userUnique: uniqueIndex('carts_user_unique').on(t.userId),
  }),
);

export const cartItems = sqliteTable(
  'cart_items',
  {
    id: text('id').primaryKey(),
    cartId: text('cart_id').notNull(),
    productId: text('product_id').notNull(),
    quantity: integer('quantity').notNull(),
    // Price snapshot from when the item was added/updated — used only to
    // detect & flag "price changed since added" (Scenario B). Never used
    // as the authoritative checkout price.
    priceAtAddKobo: integer('price_at_add_kobo').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    cartProductUnique: uniqueIndex('cart_items_cart_product_unique').on(t.cartId, t.productId),
  }),
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    status: text('status', { enum: orderStatusEnum }).notNull().default('PENDING_PAYMENT'),
    totalKobo: integer('total_kobo').notNull(),
    reference: text('reference').notNull(),
    reservationExpiresAt: text('reservation_expires_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    referenceUnique: uniqueIndex('orders_reference_unique').on(t.reference),
    userIdx: index('orders_user_idx').on(t.userId),
    statusIdx: index('orders_status_idx').on(t.status),
  }),
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    productId: text('product_id').notNull(),
    productNameSnapshot: text('product_name_snapshot').notNull(),
    unitPriceKobo: integer('unit_price_kobo').notNull(),
    quantity: integer('quantity').notNull(),
    subtotalKobo: integer('subtotal_kobo').notNull(),
  },
  (t) => ({
    orderIdx: index('order_items_order_idx').on(t.orderId),
  }),
);

// One row per (order, product) reservation of stock, with a TTL. This is
// what lets us answer Scenario F ("temporary lock reservation" vs. naive
// permanent immediate deduction) and Scenario C (release-on-failure).
export const stockReservations = sqliteTable(
  'stock_reservations',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id').notNull(),
    productId: text('product_id').notNull(),
    quantity: integer('quantity').notNull(),
    status: text('status', { enum: reservationStatusEnum }).notNull().default('ACTIVE'),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    statusExpiryIdx: index('stock_reservations_status_expiry_idx').on(t.status, t.expiresAt),
    orderIdx: index('stock_reservations_order_idx').on(t.orderId),
  }),
);

// Every inbound webhook / verify-poll result is written here BEFORE being
// acted on, keyed uniquely by (provider, eventId), so re-delivered webhooks
// become idempotent no-ops (Scenario E).
export const paymentEvents = sqliteTable(
  'payment_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    reference: text('reference').notNull(),
    orderId: text('order_id'),
    rawPayload: text('raw_payload').notNull(),
    processedAt: text('processed_at').notNull(),
  },
  (t) => ({
    providerEventUnique: uniqueIndex('payment_events_provider_event_unique').on(
      t.provider,
      t.eventId,
    ),
    referenceIdx: index('payment_events_reference_idx').on(t.reference),
  }),
);

// --- Relations (for query ergonomics; not required for correctness) ---

export const usersRelations = relations(users, ({ one, many }) => ({
  cart: one(carts, { fields: [users.id], references: [carts.userId] }),
  orders: many(orders),
}));

export const cartsRelations = relations(carts, ({ many, one }) => ({
  items: many(cartItems),
  user: one(users, { fields: [carts.userId], references: [users.id] }),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, { fields: [cartItems.cartId], references: [carts.id] }),
  product: one(products, { fields: [cartItems.productId], references: [products.id] }),
}));

export const ordersRelations = relations(orders, ({ many, one }) => ({
  items: many(orderItems),
  reservations: many(stockReservations),
  events: many(paymentEvents),
  user: one(users, { fields: [orders.userId], references: [users.id] }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] }),
}));

export const stockReservationsRelations = relations(stockReservations, ({ one }) => ({
  order: one(orders, { fields: [stockReservations.orderId], references: [orders.id] }),
  product: one(products, { fields: [stockReservations.productId], references: [products.id] }),
}));

export const productsRelations = relations(products, ({ many }) => ({
  cartItems: many(cartItems),
  orderItems: many(orderItems),
  reservations: many(stockReservations),
}));

// silence unused-import lint for `sql` (kept available for future raw defaults)
export const _sqlRef = sql`1`;
