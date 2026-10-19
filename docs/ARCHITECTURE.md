# Architecture

This document describes what is **built**. For the full target design and roadmap see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Overview

```
apps/backoffice ─┐                        ┌─ packages/shared (zod contracts, money, api client)
apps/storefront ─┼─ /api (Vite proxy) ──▶ apps/api ── Neon PostgreSQL (from Phase 2)
                 └─ packages/ui (tokens + components)
```

- npm workspaces monorepo. Workspace packages ship TypeScript source; Vite compiles them for the frontends and `tsup` bundles them into the API build.
- The frontends never talk to the database. All business rules live in API services.

## API (`apps/api`)

Request pipeline, in order (`src/app.ts`):

1. `pino-http` — structured logs; assigns a request ID (accepts a well-formed `X-Request-Id`, otherwise generates a UUID) and echoes it in the response header. Cookies, auth headers and password fields are redacted.
2. `helmet` — security headers incl. CSP; `x-powered-by` disabled.
3. `cors` — explicit origin allowlist from `CORS_ORIGINS`, credentials enabled.
4. `express.json` — 1 MB body limit.
5. `cookie-parser`, then a rate limiter on `/api` (300 req/min per IP; login has its own limit of `LOGIN_RATE_LIMIT` per 15 min).
6. OpenAPI: `/api/openapi.json` and Swagger UI at `/api/docs` (off by default in production).
7. `/api/v1/health` (liveness) and `/api/v1/health/ready` (database reachable) — unauthenticated.
8. For everything else under `/api/v1`: **origin check → session → CSRF**, then module routers, each route declaring its permission.
9. 404 handler and central error handler.

## Authentication and authorisation

- **Passwords:** argon2id (19 MiB, t=2). Minimum 10 characters. Unknown emails run a dummy verification so timing does not reveal valid accounts; all failures return the same message.
- **Lockout:** 5 consecutive failures lock the account for 15 minutes.
- **Sessions:** 32-byte random token in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-rh_sid`, `Secure`, in production). Only its SHA-256 is stored. Idle timeout `SESSION_IDLE_MINUTES` (30), absolute `SESSION_ABSOLUTE_HOURS` (12). A new token is issued at every login.
- **CSRF:** per-session synchronizer token returned by `/auth/login` and `/auth/me`, required as `X-CSRF-Token` on every state-changing request; compared in constant time. Cross-origin state-changing requests (by `Origin`) are rejected, which also covers login CSRF.
- **Forced password change:** while `must_change_password` is set (seeded owner, admin-created or admin-reset accounts) the API allows only `/auth/me`, `/auth/logout` and `/auth/change-password`.
- **RBAC:** `requirePermission(...)` on every protected route. Permissions are loaded from the database on each request, so role changes apply immediately. The Owner role implicitly holds every permission. Non-owners cannot grant roles or permissions they do not hold themselves, and cannot modify owner accounts; the last active owner cannot be disabled or demoted.
- **Revocation:** logout, password change (other sessions), password reset and disabling a user revoke sessions server-side.
- **Audit:** logins (success/failure/lockout), logouts, password changes, user/role/settings/tax/location changes are written to `audit_logs` with before/after snapshots inside the same transaction.

## Inventory engine

`src/engines/inventory/inventory.engine.ts`. `openStockSession(tx, keys, actorId)` locks the variant rows and then the balance rows (fixed order, no deadlocks) and returns a session with:

- `receive()` — stock in with a cost; updates the moving average; creates/increments the lot for batch-tracked items.
- `issue()` — stock out at the moving average; picks lots first-expiry-first-out (or a named lot); applies the expired-stock policy (`block` | `allow`), reservations and the negative-stock rule; splits value across lots so the parts sum exactly.
- `transferOut()` / `transferIn()` — move quantity and lots between locations without changing company quantity or value.

Every call writes `stock_movements` rows (the append-only stock ledger). Documents (adjustments today; purchase receipts, sales and returns in later phases) run the engine and `postJournal()` in the same transaction, so stock and the ledger change together or not at all.

## Purchasing

`src/modules/purchasing/`: orders → receipts → supplier invoices → payments, plus returns, supplier statements and aged payables (rules in [ACCOUNTING_RULES.md §5a](ACCOUNTING_RULES.md)). Every state change locks the document row (`SELECT … FOR UPDATE`) before checking its status, so concurrent post/approve/cancel requests serialise; receipt lines and invoices are locked in id order when several are touched.

### Idempotent requests

`src/lib/idempotency.ts` — `withIdempotency(scope, key, request, run)`. The (scope, key) row is claimed in `idempotency_keys` before the work runs (unique constraint), so concurrent duplicates cannot both execute; a completed request's response is stored and replayed (header `Idempotent-Replayed: true`); reusing a key with a different body is a 409. Required on `POST /supplier-payments` and, on `POST /pos/sales`, and in later phases on refunds. The back office generates one key per form instance.

## Point of sale

`src/modules/pos/` (registers, payment methods, shifts, sales) and `src/modules/customers/`. Posting rules are in [ACCOUNTING_RULES.md §5b](ACCOUNTING_RULES.md).

- `POST /pos/sales` requires an `Idempotency-Key` (scoped per cashier). In one transaction it takes the cashier's open shift `FOR SHARE` (a concurrent close waits), prices the cart with the shared `priceSale`, checks price-override and discount authority (a supervisor's approval re-checks their password like a login), issues stock through `openStockSession()` and posts one journal. Two tills selling the last unit serialise on the variant row lock; the second gets a stock error.
- `POST /pos/sales/suspend` and `POST /pos/sales/:id/resume` park and return carts without touching stock or the ledger.
- `POST /pos/shifts/:id/close` locks the shift `FOR UPDATE`, computes expected cash and posts any over/short.
- `GET /sales/:id/receipt` returns receipt data (business details, lines, VAT breakdown, payments). Users without `sales.view` see only their own sales.
- `src/lib/business-date.ts`: journal dates use the business day in `BUSINESS_TIMEZONE`.

## Accounting

`src/modules/accounting/`: chart of accounts, manual journals, periods and year-end close, opening balances, and the statements (`reports.service.ts`). Rules are in [ACCOUNTING_RULES.md §5c and §6a](ACCOUNTING_RULES.md).

- Manual drafts are `journal_entries` rows in `DRAFT` with no number; posting locks the row `FOR UPDATE`, re-validates (balance, active postable non-control accounts, open period) and numbers it from the same `JOURNAL` sequence as automatic postings.
- Period close/reopen and year-end close lock the period or year `FOR UPDATE`; `openPeriodFor()` in the posting engine reads the period `FOR SHARE`.
- Statements aggregate posted `journal_lines` per account (`totalsByAccount`). The general ledger pages with a SQL window function, so the running balance is right on every page.
- Fiscal years are built by `src/lib/fiscal-calendar.ts` (also used by the seed).
- Permissions: `accounting.view` for the ledger screens; statements accept `reports.financial` or `accounting.view` (managers see statements, not journals).

## Files

`POST /files/images` (multer, memory, size-limited) → magic-byte check with `file-type` (JPEG/PNG/WebP only) → `sharp` re-encode to WebP, max 1600 px, metadata stripped → stored under a server-generated key via the `FileStorage` interface (`LocalDiskStorage`; S3-compatible driver later). `GET /files/:id` serves public files (product images) without a session, private files only to signed-in staff, with `nosniff` and explicit content type.

## Ledger posting engine

`src/engines/posting/posting.service.ts` — `postJournal(tx, input)` and `reverseJournal(tx, id, …)`. Validates balance with `Decimal`, resolves accounts by id or `system_key`, finds the open period, numbers the entry, inserts it as DRAFT with lines and flips it to POSTED (the database trigger re-validates). Idempotent per `posting_key`. All later modules post through it — see [ACCOUNTING_RULES.md](ACCOUNTING_RULES.md).

Error handling (`src/middleware/error-handler.ts`):

| Thrown | Response |
|---|---|
| `AppError` | its status / code / details |
| `ZodError` | 400 `VALIDATION_ERROR` with `details: [{ path, message }]` |
| Malformed JSON / oversized body | 400 `VALIDATION_ERROR` / 413 `PAYLOAD_TOO_LARGE` |
| anything else | 500 `INTERNAL_ERROR`, logged server-side, no internals leaked |

Every error carries `requestId` for support tracing.

Configuration (`src/config/env.ts`) is validated with Zod at startup; the process refuses to start with invalid config.

Module layout: `src/modules/<name>/<name>.routes.ts` (+ controller, service, schemas as modules grow). Routes register their OpenAPI paths with `src/openapi/registry.ts` using the same Zod schemas used for validation.

## Frontends

- React 19, React Router 7 (data router), TanStack Query, Tailwind CSS v4 with tokens from `packages/ui`.
- Back office shell: collapsible sidebar (collapsed state remembered per browser), off-canvas navigation on mobile (Escape closes), top bar with the signed-in user, change-password and sign-out, light/dark theme, skip-to-content link. Navigation lists only implemented routes the user is permitted to use.
- `AuthProvider` loads `/auth/me`; `RequireAuth` redirects anonymous users to `/login?next=…` (same-app paths only) and forces `/account/password` when a change is pending; `RequirePermission` shows an access-denied page. Any 401 from any request drops the cached session (back to login). The CSRF token is kept in memory only.
- Forms: react-hook-form + the shared Zod schemas; server validation errors are mapped back onto fields. Dialog forms mount on open, so each opening starts clean.
- Phase 2 screens: Staff users (search, status filter, pagination, create/edit/disable, reset password), Roles & permissions (permission matrix by module, custom roles), Settings (business details, VAT-inclusive/exclusive pricing, tax rates, inventory rules, receipt text, fiscal year, locations).
- Phase 3 screens: Products (search/filters), product editor (details, variants with cosmetics attributes and barcodes, images, archive), Catalogue setup (brands, categories, units), Suppliers, Stock levels (with stock-ledger ↔ GL reconciliation), Stock adjustments (draft → post), Transfers (draft → dispatch → receive), Expiry, Stock movements.
- Phase 4 screens: Purchase orders (approve, receive, close), Goods received (from an order or direct; lots/expiry), Supplier invoices (match received goods, extra charges, live totals), Supplier payments (allocate oldest-first), Returns to suppliers, supplier account page with statement, Aged payables. Document lists share `DocumentList`.
- Phase 5 screens: Point of sale (register and shift, scan or search, cart with line discounts and price override, customer, suspend/resume, payment dialog with split tender and change, supervisor-approval prompt, printable receipt via print CSS), Sales list and detail with reprint, Shifts (open; close with cash count and variance), Customers (credit limit, balance), Settings → POS (discount limit, registers, payment methods).
- Phase 6 screens: Chart of accounts (grouped by type, balances, add/edit/deactivate), Journals (all sources, filters) and journal page (draft editor with live difference, post, delete, reverse, link to the source document), General ledger, Periods (close in order, reopen with reason, add next year, year-end close), Opening balances wizard, and Reports: Profit and loss, Balance sheet, Cash flow, Trial balance, Aged receivables (printable).
- `VariantPicker` is an accessible combobox: type to search, or scan — Enter on an exact barcode/SKU selects it.
- Routes are code-split (`React.lazy`); libraries are in long-lived vendor chunks.
- API calls go through `createApiClient` (`packages/shared`): same-origin `/api/v1`, `credentials: 'include'`, `X-CSRF-Token` on state-changing requests, typed `ApiError` from the error envelope.

## Testing

`vitest.config.ts` at the root runs each workspace as a project:

| Project | Environment | Covers |
|---|---|---|
| shared | node | Decimal rounding/tax maths, API client |
| api | node | Supertest against `createApp()`; integration tests against the real test database: auth, sessions, CSRF, lockout, RBAC, user/role/settings rules, posting engine and database guards |
| backoffice | jsdom | Layout, permission-filtered navigation, login/guards/forced password change, users page, system status |
| storefront | jsdom | Routing and layout |

API integration tests run in a single worker against a separate test database (`rhoyards_test`), reset per file; see [DATABASE.md](DATABASE.md) for why it must be a separate database.
