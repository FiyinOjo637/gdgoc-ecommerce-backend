# GDGoC Bowen University — Mini E-Commerce Backend

Backend for a mini e-commerce platform: product catalog, cart, checkout,
and Paystack payment integration. Built for the GDGoC Bowen University
Backend Development Technical Lead Assessment (2026/2027).

📄 **[DESIGN.md](./DESIGN.md)** has the full architecture rationale and a
scenario-by-scenario (A–F) breakdown of the hard concurrency/reliability
problems this project addresses — start there for the "why."

---

## Tech Stack

Node 20 · TypeScript · Express · **Drizzle ORM + SQLite** (`better-sqlite3`)
· Zod · JWT + bcrypt · Paystack (sandbox) · Jest + Supertest · OpenAPI 3 /
Swagger UI

> **Why SQLite, not Postgres?** See ["Database & portability"](./DESIGN.md#database--portability-and-the-prisma--drizzle-pivot)
> in DESIGN.md. Short version: zero-setup reproducibility for you as the
> grader (`npm install && npm test`, nothing else to stand up), with a
> documented one-line path to Postgres for production.

---

## 1. Setup

### Prerequisites

- Node.js ≥ 18 (developed on Node 20)
- npm

### Install & run

```bash
git clone <this-repo-url>
cd gdgoc-ecommerce-backend
npm install

cp .env.example .env
# .env already has sane SQLite defaults — you only need to edit
# PAYSTACK_SECRET_KEY if you want to exercise real payment calls.

npm run db:migrate     # creates dev.db and applies the schema
npm run db:seed        # seeds an admin, a demo customer, and 10 products

npm run dev             # starts the API on http://localhost:4000
```

Once running:

- API: `http://localhost:4000`
- Interactive API docs (Swagger UI): `http://localhost:4000/docs`
- Raw OpenAPI spec: `http://localhost:4000/openapi.json` (source: [`openapi.yaml`](./openapi.yaml))
- Health check: `http://localhost:4000/health`

### Seeded accounts

| Role | Email | Password |
|---|---|---|
| Admin | `admin@gdgoc.dev` | `Admin123!` |
| Customer | `customer@gdgoc.dev` | `Customer123!` |

(Overridable via `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` in `.env`.)

---

## 2. Running the tests (single command)

```bash
npm test
```

This one command:
1. Runs migrations against a **separate** SQLite test database
   (`.env.test` → `test.db`), so tests never touch your dev data.
2. Runs the full Jest suite (37 tests, `--runInBand` for deterministic
   ordering against the shared SQLite file).

No external services (no real Paystack account, no separate DB server)
are needed to run the tests — the payment gateway is mocked at the module
boundary (`jest.mock('.../paystack.service')`) so the suite is fast and
fully offline.

**The 3 candidate-defined edge-case tests** live in
[`tests/edge-cases.test.ts`](./tests/edge-cases.test.ts), each mapped
directly to a Core Engineering Scenario from the brief:

1. **Concurrent stock purchase** (Scenario A) — fires two/three checkout
   requests at the same product simultaneously via `Promise.all` and
   asserts exactly the right number succeed/fail, with stock landing at
   exactly zero, never negative.
2. **Duplicate webhook idempotency** (Scenario E) — delivers a
   byte-identical `charge.success` webhook twice and asserts the second
   delivery is a no-op (`duplicate: true`, no double stock commit).
3. **Expired reservation reclaims stock** (Scenario F) — backdates a
   reservation's TTL, runs the expiry sweep, and asserts stock is fully
   reclaimed and a late/duplicate payment cannot resurrect the expired
   order.

Other suites: `tests/auth.test.ts`, `tests/products.test.ts`,
`tests/cart.test.ts`, `tests/checkout.test.ts` (general checkout flow,
plus Scenario B live-pricing and Scenario C rollback+cart-restore).

---

## 3. Environment Variables

See [`.env.example`](./.env.example) for the full list with inline
descriptions. Summary:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file path, e.g. `file:./dev.db`. Point at Postgres in production (see DESIGN.md). |
| `PORT` | API port (default `4000`). |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Signing secrets — **change these** for any real deployment. |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Token lifetimes. |
| `PAYSTACK_SECRET_KEY` | Your Paystack **test** secret key ([dashboard](https://dashboard.paystack.com/#/settings/developer)). |
| `PAYSTACK_BASE_URL` | Paystack API base (default `https://api.paystack.co`). |
| `FRONTEND_CALLBACK_URL` | Where Paystack redirects the browser after payment. |
| `RESERVATION_TTL_MINUTES` | How long checkout holds reserved stock before releasing it (Scenario F). |
| `RECONCILIATION_POLL_INTERVAL_MS` | How often the background reservation-expiry + payment-reconciliation jobs run (Scenario D/F). |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` | Credentials for the seeded admin account. |

---

## 4. Project Structure

```
src/
  app.ts                     Express app wiring (middleware, routes, docs)
  server.ts                  Entrypoint — boots the app + background jobs
  config/env.ts               Zod-validated environment config
  db/
    schema.ts                 Drizzle schema (source of truth for the data model)
    client.ts                 better-sqlite3 connection + Drizzle instance
    migrate.ts / seed.ts       Migration runner / seed script
  middleware/                 auth (JWT+RBAC), validation, error handling
  modules/
    auth/                      register/login/refresh
    products/                  catalog CRUD, browsing/search/filter
    cart/                      cart CRUD, live price/stock flags
    orders/                    checkout, order lifecycle, reconciliation
    payments/                  Paystack client, webhook handler
  jobs/backgroundJobs.ts       reservation-expiry + reconciliation sweeps
  utils/                       jwt, password hashing, money (kobo⇄naira), errors, logger
drizzle/                      generated SQL migrations
tests/                        Jest + Supertest suite (see §2)
openapi.yaml                  OpenAPI 3.0 spec (served at /docs)
DESIGN.md                     Architecture rationale + Scenario A–F breakdown
```

---

## 5. Quick API Walkthrough

```bash
# Register
curl -X POST http://localhost:4000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane Doe","email":"jane@example.com","password":"Password123!"}'
# → { user, accessToken, refreshToken }

# Browse products
curl "http://localhost:4000/products?search=speaker&inStock=true"

# Add to cart (use the accessToken from register/login)
curl -X POST http://localhost:4000/cart/items \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"productId":"<id>","quantity":1}'

# Checkout — atomically reserves stock and returns a Paystack payment link
curl -X POST http://localhost:4000/orders/checkout -H "Authorization: Bearer $TOKEN"
# → { order: {...}, payment: { authorizationUrl, accessCode, reference } }

# Check order status
curl http://localhost:4000/orders/<orderId> -H "Authorization: Bearer $TOKEN"

# Manually re-check payment status with the gateway (Scenario D)
curl -X POST http://localhost:4000/orders/<orderId>/verify -H "Authorization: Bearer $TOKEN"
```

Full interactive documentation, with every request/response schema, is at
`/docs` once the server is running.

---

## 6. Production Build

```bash
npm run build     # compiles TypeScript to dist/
npm start          # runs the compiled server (make sure NODE_ENV=production
                    # and DATABASE_URL point at your production DB)
```

For a real deployment, also see DESIGN.md §5 ("Trade-offs & Roadmap") for
what's intentionally out of scope here (Postgres, Redis-backed rate
limiting, refresh-token revocation, etc.).
