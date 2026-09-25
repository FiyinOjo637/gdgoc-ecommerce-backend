# Design Notes

## Overview

This is a small e-commerce API built with TypeScript, Express, Drizzle and SQLite.

The main areas are:

* Authentication and role-based access
* Product management
* Cart management
* Checkout and inventory
* Paystack payments
* Payment webhooks and reconciliation

The code is split by feature instead of putting everything into one big controller/service.

---

## Database

SQLite is what i used for this project because it keeps local setup simple and does not require a separate database server.

i use drizzle to handle the dataase and migrations

but for production using postgresql will be better because of it's concurrency and some scalling features. but the database layer is kept separate so even moving away from sqlite will not warrant yoou to rewrite the application

Prices are stored as integers in kobo rather than floating-point naira values.

---

## Checkout

Checkout is handled on the server.

The client does not send the final price. The server reads the current product data, checks stock, calculates the total and creates the order.

Once an order is created, the purchased price is stored on the order item. This means later product price changes do not change existing orders.

---

## Scenario A - Concurrent Stock Purchase

The important part here is the stock update.

I don't check stock and update it as two unrelated operations. The stock update only succeeds when enough stock is still available.

Conceptually:

```sql
UPDATE products
SET stock = stock - ?
WHERE id = ?
  AND stock >= ?
```

The affected row count tells the application whether the reservation succeeded.

If two customers try to buy the last item at the same time, only the request that successfully updates the row gets the stock. The other request receives an insufficient-stock response.

This prevents stock from going below zero.

---

## Scenario B - Price Changes

Prices in the cart are not treated as final.

When the customer checks out, the server reads the current product price and calculates the order total again.

For example:

1. Product is added to cart at ₦10,000.
2. Admin changes the product to ₦12,000.
3. Customer checks out.
4. The server uses ₦12,000.

The final price is stored on the order item so the order remains consistent after checkout.

---

## Scenario C - Checkout Failure

Checkout involves both the database and Paystack, so they cannot be treated as one transaction.

The database work is kept inside a transaction. If creating the order, reserving stock or clearing the cart fails, the database transaction is rolled back.

Paystack is called only after the required database state has been created.

If payment initialization fails, the order can be moved to a failed/cancelled state and the reserved stock can be released rather than leaving inventory stuck.

The important rule is that a failed checkout should not leave behind a partially completed order or permanently reduce stock.

---

## Scenario D - Customer Leaves During Payment

A customer can leave the browser after being redirected to Paystack. The application therefore cannot depend on the browser callback to know whether payment succeeded.

Each payment has a unique reference stored with the order.

There are two ways the payment status can be updated:

* Paystack webhook
* Server-side payment verification/reconciliation

The webhook is the normal path. A background job periodically checks orders that are still waiting for payment and verifies their status with Paystack.

This covers cases where the browser was closed or a webhook was delayed.

---

## Scenario E - Duplicate Webhooks

Webhooks can be delivered more than once, so the handler must be idempotent.

The Paystack transaction reference is used to identify the payment.

Before applying a successful payment, the application checks whether that payment has already been processed.

If it has, the webhook is treated as a duplicate and no order or inventory changes are made again.

This prevents a repeated webhook from:

* Creating another order
* Updating stock twice
* Marking an order as paid multiple times

---

## Scenario F - Inventory Reservations

Stock is reserved during checkout rather than waiting until the payment webhook arrives.

The reservation has an expiry time.

If payment succeeds before the reservation expires, the order is completed.

If payment does not complete in time, a background job releases the reserved stock.

A late payment for an expired reservation is not allowed to bring the old order back to life. The payment status and reservation state are checked before the order is completed.

This prevents stock from remaining locked indefinitely when customers abandon checkout.

---

## Authentication and Access Control

Authentication uses JWT access and refresh tokens.

Protected routes require a valid access token. Admin-only routes also check the user's role.

Cart and order resources are always queried using the authenticated user's ID. A customer cannot access another customer's cart or order simply by changing an ID in the request.

Passwords are hashed before being stored.

---

## Payments

Paystack is kept behind a small service layer rather than being called directly from controllers.

This keeps payment-specific code in one place and makes it easier to test the application without making real payment requests.

Webhook requests are verified before they are processed.

The payment reference is also stored so that payment state can be reconciled later if the webhook or browser flow is interrupted.

---

## Testing

The tests use a separate SQLite database.

The important edge cases covered are:

* Two customers trying to purchase the same limited stock
* The same payment webhook being delivered twice
* An expired reservation releasing its stock

There are also tests covering authentication, products, carts and the normal checkout flow.

Payment gateway calls are mocked in tests so the suite does not depend on Paystack being available.

---

## Trade-offs

This project is intentionally small.

SQLite keeps development and testing simple, but PostgreSQL would be the best to choose if i was going for a production system with higher traffic and concurrent writes. Just like i explained above

The background jobs currently run inside the application process. In a bigger deployment, I would move scheduled work to a dedicated worker/queue system.

For production I would also add the proper rate limiting, structured monitoring, secret management and stronger refresh-token/session management.

This implementation focus on getting the main e commerce flow well without adding other infrastructure that the project does not need 
