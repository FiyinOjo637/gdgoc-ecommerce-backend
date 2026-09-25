# GDGoC Bowen University - Mini E-Commerce Backend

A simple e-commerce backend built with Node.js and TypeScript. It handles products, authentication, carts, checkout, and Paystack payments.

## Tech Stack

* Node.js + TypeScript
* Express
* Drizzle ORM + SQLite
* Zod
* JWT + bcrypt
* Paystack
* Jest + Supertest
* Swagger / OpenAPI

## Setup

### Requirements

* Node.js 18+ (Node 20 recommended cause that's what i used)
* npm

### Install

```bash
git clone <this-repo-url>
cd gdgoc-ecommerce-backend
npm install
```

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Then run:

```bash
npm run db:migrate
npm run db:seed
npm run dev
```

The API will be available at:

```text
http://localhost:4000
```

Swagger docs:

```text
http://localhost:4000/docs
```

Health check:

```text
http://localhost:4000/health
```

## Test

Run all tests with:

```bash
npm test
```

The tests use a separate SQLite database, so the dev database you're using will not be affected.

The test suite covers authentication, products, carts, checkout, concurrent purchases, duplicate webhooks, and expired reservations.

## Seeded Accounts

| Role     | Email                                           | Password     |
| -------- | ----------------------------------------------- | ------------ |
| Admin    | [admin@gdgoc.dev](mailto:admin@gdgoc.dev)       | Admin123!    |
| Customer | [customer@gdgoc.dev](mailto:customer@gdgoc.dev) | Customer123! |

These can be changed in `.env` using `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD`.

## Environment Variables

The main variables in the env file:

```text
DATABASE_URL
PORT
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
JWT_ACCESS_EXPIRES_IN
JWT_REFRESH_EXPIRES_IN
PAYSTACK_SECRET_KEY
PAYSTACK_BASE_URL
FRONTEND_CALLBACK_URL
RESERVATION_TTL_MINUTES
RECONCILIATION_POLL_INTERVAL_MS
ADMIN_SEED_EMAIL
ADMIN_SEED_PASSWORD
```

you can check `.env.example` for the full list and also for the payment to work you can add your paystack secret key but the test will work without it.

## API

These are some of the main endpoints:

```text
POST   /auth/register
POST   /auth/login
POST   /auth/refresh

GET    /products
POST   /products
GET    /products/:id

GET    /cart
POST   /cart/items
PATCH  /cart/items/:productId
DELETE /cart/items/:productId

POST   /orders/checkout
GET    /orders/:orderId
POST   /orders/:orderId/verify
```

Full API documentation is available at `/docs`.

## This is the Project Structure

```text
src/
├── app.ts
├── server.ts
├── config/
├── db/
├── middleware/
├── modules/
│   ├── auth/
│   ├── products/
│   ├── cart/
│   ├── orders/
│   └── payments/
├── jobs/
└── utils/

drizzle/
tests/
openapi.yaml
DESIGN.md
```

For the design decisions and how the system handles concurrency, pricing changes, failed checkouts, payments, duplicate webhooks, and reservations, you can check [DESIGN.md](./DESIGN.md).

## Production

Build the project with:

```bash
npm run build
```

Then start it with:

```bash
npm start
```
