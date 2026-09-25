# DESIGN.md — Mini E-Commerce Backend

GDGoC Bowen University · Backend Development Technical Lead Assessment

---

## 1. Tech Stack & Why

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 20) | Static typing catches whole classes of bugs (wrong field names, money-unit mixups) before runtime, at low ceremony cost. |
| HTTP framework | Express 4 | Minimal, unopinionated, everyone on the team can read it. The business logic here is complex enough without also fighting a framework. |
| ORM | **Drizzle ORM** over **better-sqlite3** | See "Database" below — this was a deliberate pivot away from Prisma. |
| Validation | Zod | Schema-first request validation that also gives me static types for free (`z.infer`). |
| Auth | JWT (access + refresh), bcrypt | Stateless auth is enough for this scope; refresh tokens avoid forcing re-login every 15 minutes without keeping sessions in the DB. |
| Payments | Paystack (sandbox) | Widely used in the Nigerian market GDGoC Bowen serves; well-documented webhook + verify API. |
| Testing | Jest + Supertest | Standard, fast, integrates cleanly with ts-jest. |
| Docs | OpenAPI 3.0 (`openapi.yaml`) served via Swagger UI at `/docs` | Spec-first, versionable, diff-able in code review — preferred over auto-generated-from-comments docs for a project this size. |

### Database & portability (and the Prisma → Drizzle pivot)

I started with Prisma, which is the more "default" choice for a Node/TS
backend today. I switched to **Drizzle ORM + better-sqlite3** for two
reasons, one environmental and one architectural:

1. **Environmental**: my sandboxed build environment could not reach the
   domain Prisma downloads its query-engine binary from. That's a
   me-problem, not a design flaw in Prisma — but it meant I could not
   actually *run* what I built, and an assessment about engineering
   judgment shouldn't ship code nobody verified works.
2. **Architectural**: better-sqlite3 is synchronous, has zero native
   binary-download step (its prebuild comes down as part of `npm install`
   from npm/GitHub), and needs no separate database server for a grader to
   stand up. That directly serves the brief's own "single test command"
   and "setup instructions" requirements — `npm install && npm test` works
   with nothing else running.

**Portability is still a first-class concern**, because a real deployment
should run Postgres, not SQLite-on-disk, once there's more than one app
instance. Two schema decisions specifically protect that migration path:

- **Money is stored as integer minor units (`priceKobo`, `totalKobo`, …),
  never `DECIMAL`/`FLOAT`.** SQLite has no native `DECIMAL`; Postgres does,
  but integer-cents avoids float rounding bugs either way and needs no
  schema change to move.
- **Concurrency safety comes from an atomic conditional `UPDATE`, not a
  DB-specific lock clause** (see Scenario A below). `SELECT ... FOR UPDATE`
  doesn't exist in SQLite; the conditional-update pattern used here works
  identically, and is arguably the more robust pattern, under Postgres too.

Moving to production Postgres is: change the dialect in
`drizzle.config.ts` / the schema, point `DATABASE_URL` at Postgres, run
`npm run db:generate && npm run db:migrate`. No application code changes.

### Why not immediate, unconditional stock deduction?

The obvious naive design — decrement stock the instant an item is added to
cart — was rejected early: it lets a customer "hold" stock indefinitely by
adding to cart and never checking out, starving other customers of
inventory that isn't actually sold. The chosen model (stock stays
untouched at cart-time; a **reservation** is created only at checkout, with
a TTL) is explained fully under Scenario F.

---

## 2. Data Model (see `src/db/schema.ts` for the full source of truth)

```
users ──1:1── carts ──1:N── cart_items ──N:1── products
users ──1:N── orders ──1:N── order_items ──N:1── products
orders ──1:N── stock_reservations ──N:1── products
orders ──1:N── payment_events
```

Key modelling decisions:

- **`order_items` snapshots `productNameSnapshot` and `unitPriceKobo`**
  independently of the live `products` row. An order must remain an
  accurate historical record even after a product is renamed,
  repriced, or deactivated.
- **`cart_items.priceAtAddKobo`** is *not* the checkout price — it exists
  purely so the cart view can flag "price changed since you added this"
  to the client (Scenario B). The authoritative price is always read fresh
  from `products` inside the checkout transaction.
- **`stock_reservations`** is a distinct table from `orders`/`order_items`
  rather than folding a "reserved" flag onto `products`, because a
  reservation has its own lifecycle (`ACTIVE → COMMITTED` or
  `ACTIVE → RELEASED`) and its own TTL, independent of the order's status
  text. Keeping it separate also means the expiry-sweep query
  (`status = 'ACTIVE' AND expiresAt <= now`) is a single indexed lookup.
- **`payment_events`** is an append-only audit log of every webhook/verify
  result, uniquely keyed on `(provider, eventId)`. This table *is* the
  idempotency mechanism for Scenario E, not a side effect of it.

---

## 3. Core Engineering Scenarios

### Scenario A — Concurrent Stock Purchase

**Problem**: two customers buy the last 2 units at the same millisecond;
naive "read stock, check it's enough, then write" logic has a
check-then-act race: both requests can read `stock = 1` before either
writes, and both then decrement, leaving `stock = -1`.

**Solution**: the stock decrement is a single **conditional UPDATE**,
inside a DB transaction:

```sql
UPDATE products
SET stock = stock - :qty, version = version + 1
WHERE id = :productId AND stock >= :qty
```

The `WHERE stock >= :qty` clause is re-evaluated by the database at the
instant of the write, not by the application beforehand. If two
transactions race for the same row, the database's own transaction
isolation serializes the two writes; whichever commits first sees the
"true" current stock, and the second one's `WHERE` clause fails to match
(because the first write already happened), so it updates **zero rows**.
The application checks `changes === 0` and throws a 409 Conflict, aborting
that whole checkout transaction — no partial deduction, no oversell.

This is deliberately **not** solved with an application-level mutex or an
in-memory lock, because that only works within a single process; a real
deployment runs multiple app instances behind a load balancer, and only
the database itself has a consistent view across all of them. The pattern
above is correct under Postgres with N app instances for exactly the same
reason it's correct here.

*Caveat specific to the SQLite dev setup*: `better-sqlite3` is synchronous
and single-connection, so within *this* process, JS's single-threaded
event loop already serializes calls — real concurrent races only manifest
across multiple processes/connections (i.e., under Postgres + multiple app
instances). The conditional-UPDATE pattern is what makes correctness
*not depend* on that fact, but it's worth being honest that the included
concurrency test (`tests/edge-cases.test.ts`, Edge Case 1) is verifying
the logic path rather than a true multi-process race. Given the project's
scope and time box, a full multi-process race harness was judged not worth
the setup cost — the logic itself is the thing that's provably correct,
independent of how many processes exercise it.

**Trade-off considered and rejected**: `SELECT ... FOR UPDATE` (row-level
pessimistic lock) — more "textbook," but SQLite doesn't support it, and it
also holds a lock for the duration of the transaction (including the time
spent computing the rest of the order), which is worse for throughput than
a single atomic UPDATE that fails fast.

### Scenario B — Dynamic Price Changes

**Problem**: a customer adds an item to their cart, an admin changes its
price, and the customer checks out — which price should they pay?

**Solution, two parts**:

1. **Checkout always uses the live `products.priceKobo`**, read inside the
   same transaction that decrements stock — never the cart's
   `priceAtAddKobo` snapshot. This is a deliberate choice: server-side
   price calculation (an explicit functional requirement) means the server
   is the source of truth for "what does this cost right now," not a
   value the client cached minutes or hours ago.
2. **The cart view (`GET /cart`) proactively flags drift** before the
   customer ever hits checkout: each line compares live price against
   `priceAtAddKobo` and sets `priceChanged: true` plus a `PRICE_CHANGED`
   issue if they differ, without silently updating anything. This gives
   the frontend a chance to show "this item's price changed — was ₦100,
   now ₦150" and let the customer confirm before paying, rather than
   surprising them with an unexpected total at the end.

**Trade-off considered and rejected**: locking in the cart price
("honour what they saw") is friendlier in the moment but is a security/
business problem waiting to happen — it lets a customer keep an old low
price alive indefinitely by never emptying their cart, and it means the
merchant's displayed catalog price is not actually authoritative. Given
the assessment explicitly calls for "server-side price calculation," live
pricing at checkout with proactive client-side warning was the right
balance.

### Scenario C — Partial Checkout Failures

**Problem**: checkout has both a database step (order + stock reservation
+ cart clear) and an external, non-transactional step (calling the payment
gateway to get a checkout URL). If the gateway call fails, the DB half
must not be left half-applied.

**Solution, two-phase with explicit compensation**:

- **Phase 1 (fully atomic)**: stock decrement for every line, `orders` row,
  `order_items` rows, `stock_reservations` rows, and clearing `cart_items`
  all happen inside **one `db.transaction()`**. SQLite (and Postgres)
  guarantee this is all-or-nothing — if anything in Phase 1 throws
  (e.g. a product went inactive between cart-add and checkout), the whole
  transaction rolls back automatically and nothing changed.
- **Phase 2 (external, not transactional)**: `paystack.initializeTransaction()`
  is an HTTP call and *cannot* be inside a DB transaction — you can't roll
  back a network request. So Phase 2 runs after Phase 1 has already
  committed. If it fails, the code runs an explicit **compensating
  action**: `releaseOrderReservations(orderId, 'FAILED')` restores the
  decremented stock and marks the order `FAILED`, and
  `restoreCartItems(...)` puts the same line items back in the customer's
  cart so "please try again" is actually actionable rather than making
  them re-shop from scratch.

This is the [Saga pattern](https://microservices.io/patterns/data/saga.html)
in miniature: instead of a single distributed transaction (which nothing
here supports — an HTTP call to a third party can't participate in a DB
COMMIT/ROLLBACK), correctness is achieved by making Phase 1 atomic and
Phase 2's failure mode explicitly compensable.

**Known gap**: if the process crashes *between* Phase 1 committing and the
compensating action running (e.g. the server is killed mid-request after
the gateway call throws but before `releaseOrderReservations` executes),
the order is left `PENDING_PAYMENT` with reserved stock and no in-flight
payment. This is not silently lost, though: it is caught by the **same
reservation-expiry sweep** built for Scenario F, which will expire and
release it once the TTL passes. The roadmap item for closing this
gap tighter is an outbox-pattern retry queue for Phase 2 (see §5).

### Scenario D — Abandoned Browser on Payment

**Problem**: a customer completes payment on the gateway's hosted page but
never returns to the site (closes the tab, loses connectivity, etc.).
Relying solely on the browser redirect to confirm payment is not safe.

**Solution — two independent, redundant confirmation paths**:

1. **Webhook (primary, push-based)**: Paystack calls
   `POST /webhooks/paystack` server-to-server the moment the charge
   succeeds or fails, independent of what the customer's browser does.
2. **Reconciliation polling (safety net, pull-based)**: a background job
   (`src/jobs/backgroundJobs.ts`) runs every
   `RECONCILIATION_POLL_INTERVAL_MS` and, for every order that's been
   `PENDING_PAYMENT` for more than 2 minutes, actively calls
   `GET /transaction/verify/:reference` against Paystack and applies
   whatever status comes back. This catches the case where the webhook
   itself was lost, delayed, or never fired (real-world webhook delivery
   is not 100% reliable).
3. There is also a **manual, customer/frontend-triggerable path**:
   `POST /orders/:id/verify` does the same live verify-and-apply, so a
   frontend can call it immediately when the customer returns to the
   tab (e.g. on the callback page), rather than waiting for the poll
   interval.

All three paths converge on the same `applySuccessfulPayment` /
`applyFailedPayment` functions, which are themselves idempotent
(order must be `PENDING_PAYMENT` to transition — see Scenario E), so
having three ways to trigger the same state change is safe by
construction, not by convention.

### Scenario E — Duplicate Webhooks

**Problem**: webhook providers redeliver on any ambiguous outcome
(timeout, non-2xx response, connection drop) — the *same* `charge.success`
event can arrive two or more times. Processing it twice must not
double-apply anything (double stock commit, "paying" an already-paid
order, etc.).

**Solution — durable idempotency key, checked before any side effect**:

Every inbound webhook is first reduced to an idempotency key —
`(provider, eventId)`, where `eventId` is derived from stable fields of
the event (`event type + reference + gateway id/status`) — and that pair
has a **unique index** in `payment_events`. Before doing anything else,
the handler checks whether that exact key has already been recorded:

- **Already recorded** → respond `200 { received: true, duplicate: true }`
  immediately. No order lookup, no state mutation. This is what makes
  redelivery safe even under concurrent delivery of the same event (a
  second request arriving while the first is still mid-processing would
  still be blocked by the same unique constraint at the DB level, which
  rejects a duplicate insert even under a race — belt-and-braces beyond
  the read-check).
- **Not recorded** → apply the event (`applySuccessfulPayment` /
  `applyFailedPayment`), *then* insert the `payment_events` row.

There's a second, independent layer of defence: `applySuccessfulPayment`
itself is idempotent regardless of the webhook layer — it only transitions
an order that is currently `PENDING_PAYMENT`; if the order is already
`PAID`, it's a no-op that returns the current state rather than
re-committing reservations or erroring. This means even if the
`payment_events` uniqueness check were somehow bypassed, the underlying
state transition still can't be double-applied.

**Also verified**: the webhook's `x-paystack-signature` header (HMAC-SHA512
of the *raw* request body) is checked before any of the above, using
`crypto.timingSafeEqual` for the comparison to avoid timing side-channel
leakage of the correct signature. The raw body is captured with
`express.raw()`, scoped only to the webhook route — every other route
keeps normal JSON parsing — because verifying a signature against a
*re-serialized* JSON object (rather than the exact bytes the sender
signed) is a common, silent way to break signature verification.

### Scenario F — Inventory & Failed Payments

**Problem**: choosing between two bad defaults —
(a) decrement stock immediately on `POST /cart/items`, which lets
customers "hoard" stock they never pay for, or
(b) decrement stock only on confirmed payment, which lets two customers
both "successfully" add the last unit to their carts and then have one of
them fail at payment with no graceful message.

**Solution — temporary reservation with a TTL, decided at checkout**:

- Stock is **untouched** while items sit in a cart. Cart-add only checks
  `quantity <= product.stock` as a *soft*, non-authoritative UX hint (see
  `cart.service.ts`); it never reserves anything.
- At **checkout**, stock is atomically decremented (Scenario A) and a
  `stock_reservations` row is created per line, `status = 'ACTIVE'`, with
  `expiresAt = now + RESERVATION_TTL_MINUTES` (default 15 minutes) copied
  onto the order as `reservationExpiresAt`.
- **On confirmed payment** (via webhook or verify): the reservation
  transitions `ACTIVE → COMMITTED`. The stock was already decremented at
  checkout time, so "committing" is a status-only change — it does *not*
  touch `products.stock` again (this is exactly what makes the Scenario E
  duplicate-webhook case safe: re-committing an already-`COMMITTED`
  reservation is guarded by the order-status check, not by a second stock
  write that could double-count).
- **On failed/never-completed payment**: two paths release the same way
  (`ACTIVE → RELEASED`, and `products.stock` is incremented back):
  - Immediately, if the gateway explicitly reports `charge.failed` (via
    webhook or verify).
  - Eventually, via the **reservation-expiry background sweep**
    (`expireOverdueReservations`, run on the same interval as the
    reconciliation job) for orders that neither succeed nor explicitly
    fail — the customer just abandons the checkout page. This is what
    guarantees stock isn't held hostage forever by a checkout nobody
    finishes.

**Trade-off considered**: a stricter design would put a *global* cap on
how much stock any single reservation TTL window can hold, to bound
worst-case "reservation storms" (many customers starting checkout for the
same scarce item without paying). Out of scope for this assessment's time
box, but noted in the roadmap.

---

## 4. Security Notes

- **RBAC**: `requireAuth` (verifies JWT) and `requireRole('ADMIN')` are
  composed as Express middleware; every admin-only route declares this
  explicitly rather than relying on a global "is this an admin path"
  convention, which is easy to get wrong at scale but is fully legible for
  this size of API.
- **No IDOR on carts**: there is no route that takes a cart id at all.
  Every cart route resolves "the current user's cart" from the JWT's
  `sub` claim server-side; a client structurally cannot address another
  user's cart, because no endpoint accepts one as input.
- **No IDOR on orders**: `GET /orders/:id`, `.../verify`, `.../cancel` all
  load the order first, then check `order.userId === req.user.id` (unless
  the caller is an admin) before returning/mutating anything, returning
  403 rather than 404 for a wrong-owner request (so as not to leak which
  order IDs exist — arguably 404 is also defensible here; 403 was chosen
  for clearer client-side error handling in this assessment's scope).
- **Password hashing**: bcrypt, 10 salt rounds.
- **Login response is uniform** for "wrong password" and "email doesn't
  exist" (`tests/auth.test.ts` asserts this), to avoid account
  enumeration via the error message.
- **Rate limiting**: a stricter limiter on `/auth/*` (20 req/15 min) on
  top of a global baseline limiter (300 req/min), both in-memory for this
  assessment's scope — a production deployment behind multiple instances
  should back this with Redis.
- **Webhook signature verification**: HMAC-SHA512 over the raw body,
  constant-time comparison (see Scenario E).
- **Helmet + CORS + input validation (Zod) on every mutating route.**

---

## 5. Trade-offs & Roadmap

Given the ~4–6 hour recommended scope, the following were consciously
**left out** as "known, documented gaps" rather than attempted partially:

| Area | Current state | What a production version would add |
|---|---|---|
| DB | SQLite (dev/test), documented one-line path to Postgres | Actually run Postgres + a migration in a staging environment |
| Phase-2 payment-init failure ("known gap" in Scenario C) | Compensated synchronously; a crash mid-compensation is caught eventually by the Scenario F sweep, not instantly | An outbox table + retry worker for the gateway call itself, so it's retried rather than only compensated |
| Rate limiting | In-memory, per-instance | Redis-backed, shared across instances |
| Refresh tokens | Stateless JWT, no revocation list | A refresh-token table supporting revocation/rotation on logout |
| Reservation storms | Bounded only by real stock | Optional per-SKU global reservation cap or a request queue for very high-demand items |
| Observability | `winston` structured logs to stdout | Ship to a log aggregator; add metrics (checkout success rate, webhook lag, reservation-expiry rate) |
| Email | None (no transactional email on order confirmation) | Order-confirmation and payment-failure emails, ideally queued rather than sent inline |
| Money/currency | Single currency (NGN, kobo) | Multi-currency support if the catalog needs it |

## 6. How to Verify Every Scenario Yourself

`tests/edge-cases.test.ts` contains three focused, clearly-labelled tests
mapped directly onto Scenarios A, E, and F (see the file's header comment
for the full mapping). `tests/checkout.test.ts` additionally exercises
Scenario B (live pricing) and Scenario C (compensating rollback + cart
restore) directly. Run `npm test` to execute all of them.
