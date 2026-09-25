import 'dotenv/config';
import { sqlite } from '../src/db/client';

// jest.config.js sets NODE_ENV=test which points DATABASE_URL at test.db
// (via .env.test, loaded through the `pretest` script running migrations
// against it before Jest starts). We truncate all tables before each test
// file's suite for isolation, rather than deleting/recreating the DB file,
// which is much faster.
import { users, products, carts, cartItems, orders, orderItems, stockReservations, paymentEvents } from '../src/db/schema';

export function resetDatabase() {
  sqlite.exec(`
    DELETE FROM payment_events;
    DELETE FROM stock_reservations;
    DELETE FROM order_items;
    DELETE FROM orders;
    DELETE FROM cart_items;
    DELETE FROM carts;
    DELETE FROM products;
    DELETE FROM users;
  `);
}

beforeEach(() => {
  resetDatabase();
});

afterAll(() => {
  sqlite.close();
});

// silence unused-import lint
export const _tables = { users, products, carts, cartItems, orders, orderItems, stockReservations, paymentEvents };
