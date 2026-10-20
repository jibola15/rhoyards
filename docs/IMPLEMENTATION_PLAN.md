# Cosmetics & Beauty Supply Management System — Implementation Plan

Status: **APPROVED with changes (2026-10-18)** — see "Decisions log" below.
Date: 2026-10-18

## Decisions log
| Date | Decision | Effect |
|---|---|---|
| 2026-10-18 | **Database: Neon (serverless PostgreSQL)** instead of MySQL 8 | Prisma `postgresql` provider; `NUMERIC` for money; PL/pgSQL triggers; partial unique indexes; Neon branches for dev/test |
| 2026-10-18 | Business is **VAT-registered**; users choose whether prices **include or exclude VAT** | `prices_include_tax` setting (business default) + per-product tax rate (standard / zero-rated / exempt). Tax is always computed and posted to VAT output |
| 2026-10-18 | **Online revenue recognised when payment is confirmed** | On verified payment: create `sale(channel=ONLINE)`, issue stock, post revenue + COGS. No customer-deposit stage |
| 2026-10-18 | **One physical store** | Seed a single STORE location that also fulfils online orders. Schema remains multi-location capable (a warehouse can be added later) |
| 2026-10-18 | Schema delivered **incrementally per phase** (Phase 2: identity, settings, locations, accounting core) rather than all tables up front | Each phase adds its tables in its own migration; §4 remains the target design |
| 2026-10-18 | Tests use a **separate Neon database** (`rhoyards_test`), not a schema | Schema isolation via `?schema=` is unsafe behind Neon's PgBouncer pooler (it caused a test run to truncate dev data during Phase 2). Guards added; see DATABASE.md |
| 2026-10-18 | Posting engine and ledger triggers built in Phase 2 (ahead of Phase 6 accounting UI) | Phases 3–5 post stock and sales through it from the start |
| 2026-10-19 | WAC kept as stock_qty + stock_value per variant (avg = value ÷ qty); emptying stock releases the exact remaining value | Stock ledger equals the Inventory GL balance to the kobo; reconciliation endpoint + test |
| 2026-10-19 | Supplier master data moved into Phase 3 (purchasing documents stay in Phase 4) | Matches the brief's phase list ("products, variants, suppliers, and inventory") |
| 2026-10-19 | Expiry tracking implies batch tracking; lots without a number are named from their expiry date | One mechanism (lots) for FEFO, expiry blocking and traceability |
| 2026-10-19 | Transfers are two-step (dispatch → receive) with no GL entry; in-transit quantity reported by the valuation endpoint | Value stays in Inventory throughout |
| 2026-10-19 | Product images re-encoded server-side to WebP (≤1600 px, metadata stripped) | Upload safety (no client bytes stored) and consistent storefront images |
| 2026-10-20 | Purchase price variance is expensed (5030) rather than re-costing stock | Simple and auditable for v1; stock stays at receipt cost |
| 2026-10-20 | New permission `supplier_invoices.manage` (Owner, Manager, Accountant); seed grants newly added permissions to system roles without touching edited ones | Invoice entry is accounting work, separate from receiving goods |
| 2026-10-20 | Supplier payments are final (no void); corrections via journal reversal (Phase 6) | Immutable money records |
| 2026-10-21 | POS line pricing lives in one shared function (`priceSale`, `packages/shared`) used by both the till and the API | Live totals on screen always equal what is stored and posted |
| 2026-10-21 | New permission `sales.view` (Owner, Manager, Accountant); cashiers without it see only their own sales | Sales history and receipts separated from ringing up |
| 2026-10-21 | Discount limit is a setting (`pos.maxDiscountPercent`, default 10 %); above it a supervisor with `pos.discount.override` approves at the till with their own email and password | No shared override codes; the approver is recorded on the sale |
| 2026-10-21 | Shift close posts cash over/short (4900) immediately (moved forward from Phase 8) | Cash in the ledger matches the counted drawer at every close |
| 2026-10-21 | Business day defined by `BUSINESS_TIMEZONE` (default Africa/Lagos) | A sale at 00:30 local time is dated that day, not the previous UTC day |
| 2026-10-21 | Suspended sales hold no stock and post nothing; resuming returns the cart and deletes the parked record | Parked carts cannot block or distort stock |
| 2026-10-22 | **Control accounts** (AR, AP, Inventory, GRNI) take no manual journals or opening balances | Each always equals its sub-ledger (customers, suppliers, stock, receipts); tested |
| 2026-10-22 | Only ledger-made entries (manual journals, opening balances) can be reversed from the ledger; document entries are corrected through their documents. **Supersedes 2026-10-20**: a wrong supplier payment cannot be fixed by reversing its journal (that would break AP = Σ supplier balances) | Needs a supplier-payment correction document — see known issues |
| 2026-10-22 | Periods close in date order, only after they end, and only with no draft journals in them; only the latest closed period can be reopened (reason audited) | Closed periods form an unbroken run from the start, so "closed" always means final up to a date |
| 2026-10-22 | Year-end close posts one closing entry (income/expense → Retained earnings) dated the last day of the year, then locks the year for good; the P&L leaves closing entries out | Prior-year P&L stays reportable; the balance sheet shows unclosed profit as "current earnings" |
| 2026-10-22 | Opening balances: one entry, difference to Opening balance equity; redone only by reversing it. Opening stock stays an opening-stock adjustment | No second route into Inventory that could bypass per-product valuation |
| 2026-10-22 | Cash flow uses the direct method over accounts classified CASH; each cash entry's other lines give the activity (non-current assets → investing; equity and non-current liabilities → financing; the rest operating). Opening-balance cash counts as opening cash | Exact by construction: opening + net change = closing, tested |
| 2026-10-22 | New classifications NON_CURRENT_ASSET, NON_CURRENT_LIABILITY and OTHER_EXPENSE; the classification must belong to the account type | Statements group accounts by classification |
| 2026-10-22 | Postings read their period `FOR SHARE` (app and trigger); closing locks it `FOR UPDATE` | A posting can never land in a period that is closing at the same moment |
| 2026-10-23 | Customer sign-in in `customer_accounts`, sessions in the existing `sessions` table (realm CUSTOMER, own cookie `rh_cid` and CSRF token); the store API is mounted ahead of the staff middleware | The two realms never accept each other's cookies; tested |
| 2026-10-23 | Checkout requires a customer account (no guest checkout in v1) | Every order has a customer for history, tracking and AR/refunds |
| 2026-10-23 | The cart lives in the browser (variant + quantity); the server prices and checks it on every quote and at checkout. No `carts` tables | Nothing the client sends is trusted except ids and quantities |
| 2026-10-23 | Reservations are the order's own lines (`online_orders.reservation_status` + `reserved_until`), held in `inventory_balances.qty_reserved`. No separate `stock_reservations` table | One record per hold; the engine's `reserve`/`release` keep the pool exact |
| 2026-10-23 | When a hold runs out the stock is released but the order stays "awaiting payment"; a late payment completes it if stock is there, otherwise the order goes **On hold** with the money as a customer deposit (2200). Payment for a cancelled order is also held as a deposit | Money received is never lost or mis-posted; refunds of deposits come in Phase 8 |
| 2026-10-23 | Order statuses: PENDING_PAYMENT, PAID, PROCESSING, PACKED, SHIPPED, DELIVERED, CANCELLED, ON_HOLD (no separate payment status; REFUNDED arrives with Phase 8). Store pickup goes PACKED → DELIVERED | One state machine, enforced in the service and guarded in the database |
| 2026-10-23 | Delivery is a VAT-able line at the standard rate, charged in the store's pricing mode; its net goes to Shipping income (4100) and `sales.shipping_amount` | Revenue and delivery income stay separate in the P&L |
| 2026-10-23 | A disabled, hidden **system user** authors postings with no person behind them (webhook-confirmed sales, reservation expiry) | Every journal and stock movement keeps a non-null author |
| 2026-10-23 | Test card gateway (signed webhooks) for development and tests; it cannot be enabled in production. Real gateways plug into the same interface (docs/PAYMENTS.md) | End-to-end payment flow testable without a live gateway |
| 2026-10-24 | Returns: request (`returns.create`) → approve (`returns.approve`) → refund (`refunds.process`, `Idempotency-Key`). Stock, refund and ledger happen only at the refund, in one transaction | Nothing is half-refunded; a pending return still reserves its quantity against the sale |
| 2026-10-24 | Refund caps: quantity (pending + approved + completed returns ≤ sold, plus `qty_returned ≤ qty` in the database); the last return of a line takes exactly what is left of its amounts and cost | No line is ever refunded beyond what was paid, even after rounding |
| 2026-10-24 | A return on a credit sale first reduces what the customer still owes on that sale; only the rest is paid out | AR is never left showing money the customer has had back |
| 2026-10-24 | Restocked items return at the **original sale cost** into the lots they were sold from; the journal uses exactly the stock ledger's value | Inventory stays equal to the stock ledger to the kobo |
| 2026-10-24 | Cash refunded by a cashier with an open shift reduces that shift's expected cash | Drawer counts stay right |
| 2026-10-24 | Exchanges are a return plus a new sale at the till (two documents) | No separate exchange document in v1 |
| 2026-10-24 | AR sub-ledger: `sales.amount_settled` (the only field of a completed sale that may change, guarded) + immutable customer receipts with allocations; unapplied money stays as a credit on the receipt | AR ledger = Σ customer balances; tested |
| 2026-10-24 | Expenses are **paid** expenses only (Dr expense [+ VAT input] / Cr cash or bank), draft → submitted → posted, sent back to draft with a reason. Bills to pay later stay supplier invoices | AP stays equal to supplier balances |
| 2026-10-24 | Expense receipts are private files (photos re-encoded, PDFs checked by content and served as downloads), readable only with an expenses permission | Receipts are not public and cannot run script on our origin |
| 2026-10-24 | Bank reconciliation ticks posted lines of a cash/bank account against a statement; it completes only at a nil difference and its lines are cleared for good. Card settlement is a small posting (Dr Bank, Dr Bank charges / Cr clearing), reversible from the ledger | Bank balance provable at each statement date |
| 2026-10-25 | Dashboard money figures are computed by the same functions as the statements (P&L for month to date, ledger balances for cash, AR, AP, inventory); the 30-day series is ledger net sales per entry date | Dashboard = reports, by construction; tested |
| 2026-10-25 | "Live" dashboard = refreshed every 60 seconds while open (no push channel) | Simple; accurate within a minute |
| 2026-10-25 | Operational sales report = item revenue net of VAT and discounts, less returns (by refund date), with cost; delivery charges excluded. It reconciles to the ledger's Sales revenue less Sales returns | One definition of "net sales" across screens |
| 2026-10-25 | CSV export from the API (`?format=csv`), UTF-8 with BOM, formula-injection-safe (text starting =, +, -, @ is prefixed; numbers are left as numbers) | Opens cleanly in Excel; safe to open |
| 2026-10-25 | Charts: Recharts, one validated series colour (palette slot 1, light/dark), hover tooltip and a table view; Recharts is loaded only with the dashboard | Accessible charts without weighing down other screens |
| 2026-10-26 | Production topology: API behind a reverse proxy serving both SPAs, each calling `/api` on its own origin (first-party, host-only cookies) | Simple and secure (docs/DEPLOYMENT.md) |
| 2026-10-26 | API responses carry `Content-Security-Policy: default-src 'none'`; front-end CSP is set by the proxy (`script-src 'self'`) | Nothing the API returns can run as a page |
| 2026-10-26 | E2E with Playwright against the real API on the test database (reset and seeded by `e2e/start-api.ts`) and both Vite apps | The whole money path (shop → gateway → webhook → order; till → sale; dashboard) is tested in a browser |
| 2026-10-26 | A test walks the running app's routes and fails if any is missing from the OpenAPI document | API docs stay complete |
| 2026-10-26 | `sharp` upgraded to 0.35.5 (security advisories); the Prisma CLI's `deepmerge-ts` advisory accepted until the Prisma 7 upgrade (docs/SECURITY.md) | No known reachable vulnerability in production dependencies |
| 2026-10-27 | Staff sign in with email **or** an optional username (lower case, no `@`) | Quicker at the till; never ambiguous |
| 2026-10-27 | **Two-step sign-in required for all staff**: authenticator app (TOTP) + 10 one-time backup codes; set up at first sign-in; no SMS | Phishing-resistant enough for a small business, free, works offline; no phone-number dependency |
| 2026-10-27 | Self-service password reset by email for staff and shoppers (30-minute single-use link, token in the URL fragment); SMTP via nodemailer, files in an outbox folder in development | Any email provider; nothing leaks through logs or Referer |
| 2026-10-28 | **Several stores** (supersedes "one physical store"): staff assigned to stores work only in those (documents, sales, shifts, stock moves); Owners and unassigned staff work in all; stock levels visible everywhere; reports and dashboard filter by store; receipts carry the store's address; one store at a time fulfils online orders | Branches run independently while head office sees everything |
| 2026-10-27 | Several API instances supported: rate limits in PostgreSQL, background jobs once per interval under an advisory lock (`scheduled_jobs`) | Availability and scaling without Redis or a separate scheduler |

---

## 0. Workspace inspection (findings)

| Item | Finding | Impact |
|---|---|---|
| Workspace `rhoyards/` | Empty — no existing files to preserve | Greenfield build |
| Node.js / npm | v22.17.0 / 11.8.0 | Meets requirements |
| Database | **Neon PostgreSQL** (decision 2026-10-18) — needs connection strings in `apps/api/.env` | **Blocks Phase 2 onward** (migrations, integration and concurrency tests need the real database) |
| Docker | Not installed | Not needed with Neon |
| git | Not on PATH (the Git Bash install also looks broken) | No version control yet; recommend installing before Phase 1 |

---

## 1. Architecture overview

```
┌────────────────────┐   ┌────────────────────┐
│ apps/backoffice    │   │ apps/storefront    │   React + TS + Vite + Tailwind + shadcn/ui
│ admin, POS, reports│   │ catalogue, checkout│   TanStack Query, React Router, RHF + Zod
└─────────┬──────────┘   └─────────┬──────────┘
          │ HTTPS, cookie session  │ HTTPS, cookie session (separate realm)
          ▼                        ▼
┌───────────────────────────────────────────────┐
│ apps/api  (Express + TypeScript)              │
│  middleware: helmet, rate-limit, session,     │
│  CSRF, RBAC, Zod validation, error handler    │
│  modules/*: routes → controller → service     │
│  services own transactions & business rules   │
│  posting engine (accounting), inventory engine│
│  payment provider abstraction, file storage   │
└─────────┬─────────────────────────────────────┘
          │ Prisma (least-privilege DB role)
          │ runtime: Neon pooled URL · migrations: Neon direct URL
          ▼
      Neon PostgreSQL (branches: main = prod, dev, test)
```

### Neon-specific notes
- **Latency.** Neon has no African region. The nearest are AWS Frankfurt (`eu-central-1`) and London (`eu-west-2`). An interactive transaction makes several round trips, so:
  - in production the **API must be deployed in the same region as the database**;
  - the sale, receiving and refund transactions are written to keep round trips to a minimum (batched inserts, set-based updates).
- **Connections.** Runtime uses the **pooled** connection string. Migrations use the **direct** connection string.
- **Branches.** A `test` branch (or a dedicated test database) is reset by the integration test suite, so tests never touch dev or prod data.
- **Cold starts.** Neon suspends idle compute. The first request after a pause can take about a second. Production should disable scale-to-zero or set a minimum compute size.

Key principles:
- **One inventory engine and one posting engine.** Every module (POS, online, purchasing, returns, adjustments, expenses) goes through `InventoryService` and `PostingService`, so the accounting and stock rules exist in one place.
- **Unified sales ledger.** An online order is a commercial document. When it is fulfilled it creates a `sale` with `channel = ONLINE`. This means revenue, COGS and channel reports read from one table.
- **Shared contracts.** Zod schemas live in `packages/shared` and are used by the API (validation), both frontends (forms) and OpenAPI generation (`@asteasolutions/zod-to-openapi`).
- **Append-only financial and stock records.** Stock movements and posted journal lines are never updated or deleted. This is enforced in the service layer **and** by PostgreSQL triggers.

### Additional libraries (proposed)
| Concern | Choice |
|---|---|
| Decimal maths | `Prisma.Decimal` (decimal.js), wrapped in `packages/shared/money.ts` |
| Password hashing | `argon2` (argon2id) |
| Sessions | Custom `sessions` table (hashed token, HttpOnly + Secure + SameSite cookie) |
| CSRF | Synchronizer token bound to the session, sent as an `X-CSRF-Token` header |
| Rate limiting | `express-rate-limit` (stricter on auth, checkout and webhooks) |
| Security headers | `helmet` with a strict CSP |
| Uploads | `multer` (memory, size-limited) + `file-type` magic-byte sniffing + `sharp` re-encode for images |
| Logging | `pino` with a request ID |
| Tables (UI) | TanStack Table (server-side paging/sorting) |
| Charts | Recharts |
| E2E tests | **Playwright** (proposed addition — the brief lists Vitest/RTL/Supertest; Playwright covers browser E2E) |

---

## 2. Folder structure

```
rhoyards/
├─ package.json                # npm workspaces + root scripts
├─ tsconfig.base.json
├─ .env.example
├─ README.md
├─ docs/
│  ├─ IMPLEMENTATION_PLAN.md   # this file
│  ├─ ARCHITECTURE.md
│  ├─ DATABASE.md
│  ├─ ACCOUNTING_RULES.md
│  ├─ API.md                   # conventions + link to /api/docs (Swagger UI)
│  └─ PAYMENTS.md              # provider integration requirements
├─ packages/
│  ├─ shared/                  # zod schemas, DTO types, enums, permission codes, money helpers
│  └─ ui/                      # shadcn/ui components, Tailwind preset, design tokens
├─ apps/
│  ├─ api/
│  │  ├─ prisma/
│  │  │  ├─ schema.prisma
│  │  │  ├─ migrations/        # Prisma migrations + raw SQL (CHECKs, triggers)
│  │  │  └─ seed/              # repeatable, idempotent seed (CoA, roles, demo catalogue)
│  │  ├─ src/
│  │  │  ├─ server.ts, app.ts
│  │  │  ├─ config/env.ts      # zod-validated environment
│  │  │  ├─ lib/               # prisma, errors, logger, pagination, sequences, idempotency, storage
│  │  │  ├─ middleware/        # auth, requirePermission, csrf, validate, rateLimit, errorHandler
│  │  │  ├─ engines/
│  │  │  │  ├─ inventory/      # issue/receive/transfer, FEFO, WAC, locking
│  │  │  │  └─ posting/        # journal builder, balance check, posting rules per document type
│  │  │  ├─ modules/
│  │  │  │  ├─ auth/ users/ roles/ settings/ audit/ files/
│  │  │  │  ├─ catalog/        # products, variants, brands, categories, units, barcodes, images
│  │  │  │  ├─ locations/ inventory/ adjustments/ transfers/
│  │  │  │  ├─ suppliers/ purchasing/   # PO, GRN, supplier invoices, returns, payments
│  │  │  │  ├─ customers/
│  │  │  │  ├─ pos/            # registers, shifts, sales, suspended sales, receipts
│  │  │  │  ├─ returns/        # returns, refunds, exchanges
│  │  │  │  ├─ storefront/     # public catalogue, cart, checkout, customer auth
│  │  │  │  ├─ orders/         # admin order management, fulfilment
│  │  │  │  ├─ payments/       # provider interface, manual/test provider, webhooks
│  │  │  │  ├─ expenses/
│  │  │  │  ├─ accounting/     # CoA, journals, periods, reconciliation, opening balances
│  │  │  │  ├─ reports/ dashboard/
│  │  │  │  └─ (each: *.routes.ts, *.controller.ts, *.service.ts, *.schemas.ts)
│  │  │  └─ openapi/
│  │  └─ tests/  unit/ integration/ helpers/ (test DB reset, factories)
│  ├─ backoffice/
│  │  └─ src/ app/ (layout, sidebar, router) features/<module>/ components/ lib/api.ts
│  └─ storefront/
│     └─ src/ pages/ features/ components/ lib/api.ts
└─ e2e/                        # Playwright specs
```

Why two frontends: the storefront is public-facing. Keeping it separate keeps staff/admin code out of the public bundle, lets it use its own session realm, and lets it be deployed and cached independently. Shared UI comes from `packages/ui`.

---

## 3. Cross-cutting conventions

### Money and quantities
- PostgreSQL `NUMERIC(p,s)` only — never `real`/`double precision`. The sizes below are written in `DECIMAL(p,s)` notation, which is the same type.
  - Money amounts: `DECIMAL(18,2)` (NGN and kobo).
  - Unit costs and the average cost: `DECIMAL(18,4)`, so that weighted-average cost doesn't drift.
  - Quantities: `DECIMAL(14,3)`. Units can opt into fractional quantities, e.g. bulk ml or kg; the default is whole units.
  - Rates: `DECIMAL(7,4)` (for example 7.5000 %).
- In JS all arithmetic uses `Decimal` and never `number`. Lint rules and helper functions enforce this.
- Rounding: **ROUND_HALF_UP to 2 dp at line level**. Document totals are the sum of the rounded lines. This is documented in ACCOUNTING_RULES.md.
- API JSON sends money as **strings** (`"12500.00"`) to avoid float parsing.

### API
- Base path `/api/v1`. Staff routes are under `/api/v1/admin/*` and public/customer routes under `/api/v1/store/*`.
- Success responses: `{ data, meta? }`. Lists return `meta: { page, pageSize, total }`.
- Error responses: `{ error: { code, message, details?, requestId } }` with correct status codes (400 validation, 401, 403, 404, 409 conflict/stock, 422 business rule, 429).
- Lists support `?page=&pageSize=&sort=field:asc&q=&<filters>`, all applied on the server.
- An **`Idempotency-Key` header** is required on money- or stock-affecting POSTs (complete sale, payment, refund, receive goods, supplier payment). It is stored in `idempotency_keys` with a request hash; a replay returns the original response.
- Swagger UI is served at `/api/docs`, generated from the Zod schemas.

### Transactions and concurrency
- Every money, stock or accounting operation runs in one `prisma.$transaction` (interactive, with a timeout). Writes within it happen in this order: validate → lock → write document → stock → journal → audit.
- Stock locking uses `SELECT … FOR UPDATE` on `inventory_balances` and `inventory_batches` rows, **always taken in ascending (variant_id, location_id) order** to avoid deadlocks. Stock decrements are conditional (`UPDATE … SET qty = qty - ? WHERE id = ? AND qty >= ?`) and the affected row count is checked.
- A deadlock or lock timeout gets a bounded retry (up to 3 times with jitter). Retries are safe because of the idempotency key.
- Document numbers (e.g. `INV-2026-000123`) come from a `document_sequences` row that is locked `FOR UPDATE` inside the same transaction, so the numbers have no gaps.

### Soft delete and archival
- Master data (products, suppliers, customers, accounts) uses `archived_at`/`deleted_at`. Records with history can be archived but not hard-deleted.
- Transactional documents are never deleted. They are **voided, cancelled or reversed** instead.
- Foreign keys use `ON DELETE RESTRICT` for anything that touches posted records.

### Audit
- `audit_logs` records the actor, action, entity, before/after JSON, IP and request ID. It is written inside the same transaction as the change.
- Documents carry `created_by`, `updated_by`, `approved_by`, `cancelled_by`, `reversed_by` and their timestamps.

---

## 4. Database schema (proposed)

The full Prisma schema is written in Phase 2. These are the tables, their key columns and the constraints that matter. All tables have `id`, `created_at` and `updated_at`.

### 4.1 Identity, security, settings
| Table | Key columns / constraints |
|---|---|
| `users` | email **UNIQUE**, password_hash, full_name, status (ACTIVE/DISABLED), failed_login_count, locked_until, last_login_at |
| `roles` | code **UNIQUE** (OWNER, MANAGER, ACCOUNTANT, INVENTORY_OFFICER, CASHIER, ONLINE_ORDER_MANAGER), name, is_system |
| `permissions` | code **UNIQUE**, e.g. `sales.create`, `sales.discount.override`, `refunds.approve`, `journals.reverse`, `stock.negative.allow` |
| `role_permissions` | PK(role_id, permission_id) |
| `user_roles` | PK(user_id, role_id) |
| `user_locations` | PK(user_id, location_id) — restricts cashiers and inventory staff to their locations |
| `sessions` | token_hash **UNIQUE**, realm (STAFF/CUSTOMER), user_id / customer_id, csrf_secret, expires_at, idle_expires_at, ip, user_agent |
| `audit_logs` | actor_user_id, action, entity_type, entity_id, before JSON, after JSON, ip, request_id; INDEX(entity_type, entity_id), INDEX(created_at) |
| `settings` | key **UNIQUE**, value JSON — business name/address, currency (default NGN), fiscal year start, receipt header/footer, prices_include_tax, allow_negative_stock, block_expired_sale, expiry_warning_days, online_fulfilment_location_id |
| `tax_rates` | name, rate DECIMAL(7,4), output_account_id, input_account_id, active — **no hardcoded rates** |
| `payment_methods` | code **UNIQUE**, name, kind (CASH/CARD/BANK_TRANSFER/OTHER), ledger_account_id, requires_reference, active, available_pos, available_online |
| `document_sequences` | key **UNIQUE**, prefix, next_value |
| `idempotency_keys` | (scope, key) **UNIQUE**, request_hash, status, response JSON, expires_at |
| `files` | storage_key **UNIQUE**, original_name, mime, size, sha256, uploaded_by |

### 4.2 Catalogue
| Table | Key columns / constraints |
|---|---|
| `brands` | name **UNIQUE**, slug **UNIQUE**, archived_at |
| `categories` | parent_id (self FK), name, slug **UNIQUE**, sort_order |
| `units` | code **UNIQUE** (pc, ml, g, set…), name, allows_fraction |
| `products` | name, slug **UNIQUE**, brand_id, category_id, unit_id, tax_rate_id, description, is_expiry_tracked, is_batch_tracked, status (DRAFT/ACTIVE/DISCONTINUED), online_visible, archived_at |
| `product_variants` | product_id, **sku UNIQUE**, name, shade, colour, tone, size, volume_value, volume_unit_id, selling_price, compare_at_price, standard_cost, **avg_cost DECIMAL(18,4)** (system-maintained WAC), reorder_level, reorder_qty, status, archived_at |
| `variant_barcodes` | **barcode UNIQUE**, variant_id, is_primary |
| `product_images` | product_id, variant_id NULL, file_id, alt_text, sort_order |

### 4.3 Locations and inventory
| Table | Key columns / constraints |
|---|---|
| `locations` | code **UNIQUE**, name, type (STORE/WAREHOUSE), pos_enabled, active |
| `inventory_balances` | **UNIQUE(variant_id, location_id)**, qty_on_hand, qty_reserved; CHECK(qty_reserved ≥ 0) |
| `inventory_batches` | variant_id, location_id, lot_number, mfg_date, expiry_date, qty_on_hand, status (AVAILABLE/QUARANTINE/EXPIRED); **UNIQUE(variant_id, location_id, lot_number, expiry_date)**; INDEX(variant_id, location_id, expiry_date) for FEFO |
| `stock_movements` | variant_id, location_id, batch_id NULL, type (OPENING, PURCHASE_RECEIPT, PURCHASE_RETURN, SALE, SALE_RETURN, ADJUSTMENT, WRITE_OFF, TRANSFER_OUT, TRANSFER_IN), qty_change (signed), unit_cost, total_cost, qty_after, avg_cost_after, source_type, source_id, source_line_id, created_by; **UNIQUE(source_type, source_line_id, batch_id, type)** to stop double processing; **append-only (trigger)** |
| `stock_adjustments` / `_lines` | number **UNIQUE**, location_id, reason (COUNT, DAMAGE, EXPIRY, THEFT, OTHER), status (DRAFT/POSTED/CANCELLED), approved_by; lines: variant, batch, qty_change, unit_cost |
| `stock_transfers` / `_lines` | number, from_location, to_location, status (DRAFT/DISPATCHED/RECEIVED/CANCELLED); lines: variant, batch, qty_sent, qty_received |
| `stock_reservations` | online_order_item_id, variant, location, qty, expires_at, status (ACTIVE/CONSUMED/RELEASED) |

### 4.4 Purchasing and suppliers
| Table | Key columns / constraints |
|---|---|
| `suppliers` | code **UNIQUE**, name, contact fields, tax_id, payment_terms_days, archived_at |
| `purchase_orders` / `_lines` | number **UNIQUE**, supplier, location, status (DRAFT/APPROVED/PARTIALLY_RECEIVED/RECEIVED/CLOSED/CANCELLED), totals, approved_by; lines: variant, qty_ordered, **qty_received** (CHECK ≤ qty_ordered unless over-receipt is allowed), unit_cost, tax_rate |
| `goods_receipts` / `_lines` | number, po_id NULL, supplier, location, received_at, journal_entry_id; lines: po_line_id, variant, qty, unit_cost, lot, mfg_date, expiry_date, batch_id |
| `supplier_invoices` / `_lines` | number, **UNIQUE(supplier_id, supplier_ref)** (blocks entering the same invoice twice), invoice_date, due_date, subtotal, tax, total, amount_paid, status (DRAFT/POSTED/PARTIALLY_PAID/PAID/VOID); lines link to grn_line or a non-stock expense account |
| `supplier_payments` + `supplier_payment_allocations` | payment: supplier, date, amount, payment_account_id, reference; allocation: (payment, invoice, amount); allocations sum ≤ payment, and the invoice's amount_paid ≤ its total |
| `purchase_returns` / `_lines` | number, supplier, location, original GRN, status, journal_entry_id; lines: variant, batch, qty, unit_cost |

### 4.5 Customers
| Table | Key columns / constraints |
|---|---|
| `customers` | code **UNIQUE**, type (RETAIL/WHOLESALE), name, email **UNIQUE NULL**, phone, allow_credit, credit_limit, archived_at. Walk-in customers are a single system record. |
| `customer_credentials` | customer_id **UNIQUE**, password_hash, email_verified_at — kept apart from staff `users` |
| `customer_addresses` | customer_id, label, recipient, phone, line1/2, city, state, country, is_default |
| `customer_receipts` + `customer_receipt_allocations` | payments against credit sales (AR) |

### 4.6 POS and sales
| Table | Key columns / constraints |
|---|---|
| `registers` | location_id, name, active |
| `cashier_shifts` | register_id, user_id, opened_at, opening_float, closed_at, expected_cash, counted_cash, variance, status (OPEN/CLOSED); **at most one OPEN shift per register** (partial unique index `WHERE status = 'OPEN'`) |
| `sales` | number **UNIQUE**, channel (POS/ONLINE), location_id, customer_id, shift_id, online_order_id **UNIQUE NULL**, status (SUSPENDED/COMPLETED/VOIDED), subtotal, discount_total, tax_total, total, amount_paid, balance_due, cost_total, discount_approved_by, **idempotency_key UNIQUE**, journal_entry_id, completed_at |
| `sale_items` | sale_id, variant_id, name/sku snapshot, qty, unit_price, discount_amount, tax_rate snapshot, tax_amount, line_total, **unit_cost (WAC at issue)**, **qty_returned** CHECK(qty_returned ≤ qty) |
| `sale_item_batches` | sale_item_id, batch_id, qty — FEFO traceability |
| `sale_payments` | sale_id, payment_method_id, amount, tendered, change_given, reference; the sum of payments must equal the total, or the shortfall goes to AR for an authorized credit sale |

### 4.7 Returns, refunds, exchanges
| Table | Key columns / constraints |
|---|---|
| `sale_returns` | number, sale_id, kind (RETURN/EXCHANGE), reason_code, status (PENDING_APPROVAL/APPROVED/COMPLETED/REJECTED), requested_by, approved_by, refund_total, exchange_sale_id, journal_entry_id |
| `sale_return_items` | sale_item_id, qty, condition (RESALEABLE/OPENED/DAMAGED/EXPIRED), restock, restock_location_id, refund_amount, tax_amount, unit_cost |
| `refunds` | return_id, payment_method_id, amount, reference, **idempotency_key UNIQUE**, status |

### 4.8 Online store
| Table | Key columns / constraints |
|---|---|
| `carts` / `cart_items` | customer_id or anonymous token, variant, qty |
| `shipping_methods` | name, zone/states JSON, fee, active |
| `online_orders` | number **UNIQUE**, customer_id, status (PENDING, PAYMENT_PENDING, PAID, PROCESSING, PACKED, SHIPPED, DELIVERED, CANCELLED, REFUNDED), payment_status, address snapshot, shipping_method, shipping_fee, subtotal, tax, total, fulfilment_location_id, sale_id **UNIQUE NULL** |
| `online_order_items` | order_id, variant, snapshots, qty, unit_price, tax, line_total |
| `order_status_history` | order_id, from_status, to_status, changed_by, note — transitions validated by a state machine |
| `payment_attempts` | order_id, provider, **UNIQUE(provider, provider_reference)**, amount, currency, status (INITIATED/PENDING/SUCCEEDED/FAILED), verified_at |
| `payment_webhook_events` | provider, event_id, **UNIQUE(provider, event_id)**, signature_valid, payload JSON, processed_at, result |

### 4.9 Expenses
| Table | Key columns / constraints |
|---|---|
| `expense_categories` | name **UNIQUE**, default_account_id |
| `expenses` | number, expense_date, category_id, expense_account_id, supplier_id NULL / payee_name, description, amount, tax_amount, total, settlement (PAID_NOW/ON_ACCOUNT), payment_account_id, status (DRAFT/SUBMITTED/APPROVED/POSTED/REJECTED/VOID), submitted_by, approved_by, journal_entry_id |
| `expense_attachments` | expense_id, file_id |

### 4.10 Accounting
| Table | Key columns / constraints |
|---|---|
| `accounts` | code **UNIQUE**, name, type (ASSET/LIABILITY/EQUITY/INCOME/EXPENSE), subtype, parent_id, is_postable, **system_key UNIQUE NULL** (INVENTORY, AR, AP, GRNI, VAT_OUTPUT…), is_active |
| `fiscal_years` / `accounting_periods` | period start/end, status (OPEN/CLOSED); posting into a CLOSED period is rejected |
| `journal_entries` | number **UNIQUE**, entry_date, period_id, source_type, source_id, **posting_key UNIQUE** (e.g. `SALE:123:ISSUE` — blocks double posting), description, status (DRAFT/POSTED), **reversal_of_id UNIQUE NULL**, total_debit, total_credit, posted_by, posted_at |
| `journal_lines` | entry_id, account_id, debit DECIMAL(18,2), credit DECIMAL(18,2), memo, customer_id, supplier_id, location_id; **CHECK(debit ≥ 0 AND credit ≥ 0 AND (debit = 0) <> (credit = 0))** |
| `bank_reconciliations` / `bank_reconciliation_lines` | account_id, statement_date, statement_balance, status; lines mark journal_lines as cleared (UNIQUE journal_line_id per reconciliation) |

**Database-level guards (raw SQL in migrations):**
1. A `BEFORE UPDATE` trigger on `journal_entries` rejects the change to POSTED unless SUM(debit) = SUM(credit) > 0, and rejects any change to an entry that is already POSTED.
2. `BEFORE UPDATE/DELETE` triggers on `journal_lines` (when the parent entry is posted) and on `stock_movements` raise an error.
3. CHECK constraints and partial unique indexes are as listed above. Prisma can't express them, so they go in raw SQL migrations (PL/pgSQL for the triggers).

The application connects as a Neon role with DML rights only (no DDL). A separate migration role owns the schema.

---

## 5. Accounting workflow

### 5.1 Inventory costing — moving weighted-average cost (WAC)
- WAC is kept **per variant, company-wide** (not per location), so transfers don't change the cost.
- On every inbound movement with a cost (receipt, opening stock, positive adjustment, restocked return):
  `new_avg = (qty_on_hand_total × avg + qty_in × unit_cost_in) / (qty_on_hand_total + qty_in)`
- Outbound movements (sale, write-off, negative adjustment, purchase return) are valued at the **current avg_cost**. The stock movement and the COGS journal line use the same figure.
- Batches/lots track **quantity and expiry for FEFO and traceability only**. They don't carry a separate cost, because WAC is the documented method.
- Under the inventory engine, inventory valuation report = Σ(qty_on_hand × avg_cost) = the GL Inventory balance. A reconciliation test checks this.

### 5.2 Seed chart of accounts (abridged; fully editable after seeding)
```
1000 Cash on hand (per register/location)   2000 Accounts payable
1010 Bank accounts                          2010 Goods received not invoiced (GRNI)
1020 Card / POS terminal clearing           2100 VAT output (tax payable)
1030 Payment gateway clearing               2110 VAT input (recoverable)*
1100 Accounts receivable                    2200 Customer deposits (unearned)
1200 Inventory                              3000 Owner's equity / capital
                                            3100 Retained earnings
4000 Sales revenue                          3900 Opening balance equity
4010 Sales returns & allowances (contra)
4020 Sales discounts (contra)               5000 Cost of goods sold
4100 Shipping income                        5010 Inventory adjustments / shrinkage
4900 Cash over/short                        5020 Expired & damaged stock write-off
                                            5030 Purchase price variance
                                            6xxx Operating expenses (rent, salaries, utilities, marketing…)
```
\*Input VAT is configurable as recoverable or non-recoverable. It is not assumed.

### 5.3 Posting rules
| Event | Journal entry |
|---|---|
| **Goods received (GRN)** | Dr Inventory / Cr GRNI — at the PO/GRN unit cost; WAC updated |
| **Supplier invoice** | Dr GRNI (matched received value), Dr VAT input (if recoverable), Dr/Cr Purchase price variance (invoice ≠ GRN price) / Cr AP. Non-stock invoice lines: Dr expense account |
| **Supplier payment** (partial allowed) | Dr AP / Cr Bank or Cash |
| **Purchase return** | Dr AP (or GRNI if not yet invoiced) / Cr Inventory at current WAC; difference to the supplier credit goes to PPV |
| **POS sale** | Dr Cash / Card clearing / Bank (per payment method) [+ Dr AR for an authorized credit balance]; Cr Sales revenue (net of discounts\*\*); Cr VAT output. **And** Dr COGS / Cr Inventory at WAC |
| **Credit sale receipt** | Dr Cash/Bank / Cr AR |
| **Online payment confirmed** (verified webhook or manual verification) — revenue recognised here | Dr Gateway clearing or Bank / Cr Sales revenue, Cr Shipping income, Cr VAT output; **and** Dr COGS / Cr Inventory at WAC (reservation converted to a stock issue) |
| **Online order cancelled after payment** | Handled as a full return + refund (restock, reverse revenue/VAT/COGS) |
| **Sales return + refund** | Dr Sales returns, Dr VAT output / Cr Cash, Bank or AR (refund). If **restocked**: Dr Inventory / Cr COGS at the **original sale-line unit cost**. If not restocked (damaged/expired), there is no inventory entry; the loss remains in COGS. |
| **Exchange** | Return entry + new sale entry; only the net difference is settled in cash |
| **Stock adjustment** | Increase: Dr Inventory / Cr Inventory adjustments. Decrease: Dr Shrinkage or Write-off / Cr Inventory (at WAC) |
| **Stock transfer** | No GL entry (same legal entity). Stock movements only. |
| **Expense** | Dr Expense account [+ Dr VAT input] / Cr Cash/Bank (paid now) or AP (on account) |
| **Shift close** | Variance: Dr/Cr Cash over/short. Cash banking: Dr Bank / Cr Cash on hand |
| **Card settlement / bank reconciliation** | Dr Bank, Dr Bank charges / Cr Card clearing |
| **Opening balances** | Each account / Opening balance equity. Opening stock goes through OPENING stock movements so that stock and GL agree. |
| **Year-end close** | Income and expense accounts → Retained earnings |

\*\*Discounts: proposed to post revenue **net** of line discounts, and to record the discount amount on the sale for reporting. A separate Sales-discounts contra account is optional (configurable).

### 5.4 Ledger integrity rules
- `PostingService.post()` builds the lines, checks Σdebit = Σcredit (with Decimal), checks the period is open, and inserts with a unique `posting_key`. A replay therefore hits the unique constraint and returns the existing entry, so nothing is posted twice.
- Posted entries are immutable. A correction is made with `reverse(entryId)`, which creates a mirror entry with `reversal_of_id` set (UNIQUE, so an entry can be reversed only once), followed by a new replacement entry.
- **Gross profit** = Net sales − COGS. **Net profit** = Gross profit + other income − operating expenses − write-offs/shrinkage ± adjustments. Both are computed from posted journal lines only.
- The AR and AP control accounts are reconciled to their subledgers (customer and supplier documents) in reports and tests.
- Reports (TB, P&L, BS, cash flow, ageing) read from posted journal lines and documents only — never from cached figures. The cash flow statement uses the **direct method**, from movements in cash and bank accounts classified by source type.

---

## 6. Key workflows (transaction boundaries)

**Complete POS sale** (one DB transaction, `Idempotency-Key` required):
1. Validate the cart (Zod), the cashier's permissions and location, the open shift, discount authority, and that payments sum to the total.
2. Lock the inventory balance and batch rows (sorted order), check availability, and check expiry (block expired items if configured).
3. Insert the sale, items, payments and FEFO batch allocations.
4. Decrement balances and batches, and insert stock movements (SALE, at WAC).
5. Post the journal (revenue/tax/payment + COGS) — using the same unit cost as step 4.
6. Write the audit log and store the idempotency response.

If anything throws, the whole transaction rolls back and nothing partial is left.

**Online order:**
1. Checkout creates an order (PENDING / PAYMENT_PENDING) and **reserves** stock (raises `qty_reserved`, with a TTL) at the fulfilment location, which is the store.
2. A verified payment marks the order PAID. In one transaction this consumes the reservation, creates a `sale(channel=ONLINE)`, issues the stock (FEFO, WAC) and posts revenue, VAT, shipping income and COGS.
3. The order then moves through PROCESSING → PACKED → SHIPPED → DELIVERED. These are fulfilment states only, with no further postings.
4. Cancelling before payment releases the reservation. Cancelling after payment runs the return and refund flow.

Expired reservations are released by a scheduled job. Available-to-sell = on_hand − reserved, which POS respects too, so both channels share one stock pool.

**Payments abstraction:**
`PaymentProvider { initiate(order), verify(reference), parseWebhook(rawBody, headers) }`.
- In the initial release there is a `ManualProvider` (staff with `payments.verify` confirm the transfer, and the action is audited) and a `TestProvider` (sandbox with HMAC-signed webhooks for tests).
- Webhooks are stored first, with UNIQUE(provider, event_id), then processed idempotently.
- A browser redirect never marks an order paid.
- Real providers (e.g. Paystack or Flutterwave) can be added later. The requirements will be documented in `docs/PAYMENTS.md`.

---

## 7. Phased delivery

At the end of each phase I will: list the files changed, run migrations, typecheck, lint and tests, fix failures, and update the docs and the "known issues" section.

| # | Phase | Main deliverables | Tests at phase end |
|---|---|---|---|
| 1 | Setup and infrastructure | npm workspaces, TS configs, ESLint/Prettier, Vite apps with Tailwind + shadcn, Express skeleton (helmet, logging, error handler, env validation), Vitest config, `.env.example`, README | Health endpoint (Supertest), app shell render (RTL) |
| 2 | Schema, migrations, auth | Full Prisma schema, raw-SQL triggers/CHECKs, seed (CoA, roles/permissions, settings, demo data), sessions, login/logout, CSRF, rate limits, RBAC middleware, users/roles admin UI, audit logging | Auth flows, RBAC denial (#11), journal trigger rejects an unbalanced entry |
| 3 | Catalogue and inventory | Brands, categories, units, products/variants/barcodes/images (secure upload), locations, balances, batches, inventory engine (WAC, FEFO, locking), adjustments, transfers, stock movement ledger UI | #1 product CRUD, WAC maths, FEFO, negative-stock block |
| 4 | Purchasing | Suppliers, PO → GRN (partial) → supplier invoice → payments (partial) → purchase returns, supplier statements | #2 receiving increases stock and posts GRNI |
| 5 | POS and payments | Registers, shifts, POS screen (barcode, search, cart, discounts, tax, split pay, customer), suspend/resume, receipts (print CSS), payment methods | #3 stock reduced once, #5 concurrent oversell, #6 split payments, #7 rollback, #9 revenue/COGS, #14 expiry block |
| 6 | Accounting and financial reports | CoA UI, manual journals (draft → post), reversals, periods and close, opening balances wizard, GL, TB, P&L, BS, cash flow, AR/AP ageing | #8 always balanced, posted immutability, #13 report reconciliation |
| 7 | Storefront and orders | Catalogue, filters, PDP, cart, customer auth, checkout, shipping fees, reservations, order history and tracking, admin order management, payment abstraction + manual/test providers, webhooks | #4 shared stock, #12 duplicate webhook |
| 8 | Expenses, returns, reconciliation | Expense workflow + attachments, returns/refunds/exchanges with approvals, customer receipts, bank/cash reconciliation, shift reconciliation | #10 refund cap, duplicate refund, restock COGS reversal |
| 9 | Dashboard and reporting | Live dashboard (Recharts), operational reports with filters, CSV export, audit log viewer | Dashboard figures = ledger/report figures |
| 10 | Hardening and release | Security review (CSP, upload, rate limits, session settings), Playwright E2E, OpenAPI completeness, docs, production build, deployment guide | Full suite + E2E green |

Integration tests run against a dedicated Neon `test` branch, which is reset per test file. A real PostgreSQL database is required: the locking, trigger and concurrency guarantees can't be tested on SQLite or with mocks.

### Known issues and limitations (v1 release)

- **Customer and supplier opening balances** cannot be entered yet: their control accounts are closed to manual entries, and there is no "opening invoice" document. Start with zero balances, or enter the open supplier invoices as supplier invoices.
- **Unapplied customer credit** (payment received with nothing to apply it to) cannot later be applied to a new credit sale; it stays as a credit that reduces the customer's balance.
- **Aged receivables** for a past date use today's settlement state (payments and returns after that date are already netted).
- **Correcting a supplier payment** keyed against the wrong supplier or amount still has no document (payments are final; their journals cannot be reversed from the ledger). Workaround: a manual journal Dr Bank / Cr Purchase price variance or Other income, agreed with the supplier, until a reversal document is added.
- **Aged receivables** ages each credit sale from its sale date (customers have no payment terms yet).
- **Cash flow** lists every non-cash line of a cash entry, so a sale shows its cost of sales and the matching inventory reduction as two operating lines that cancel out.
- **No guest checkout** and **no customer emails** (order confirmation, payment received, dispatched) yet; customers follow their orders on the website.
- **No real card gateway** yet; bank transfer (staff-verified) and the test gateway only. See [PAYMENTS.md](PAYMENTS.md).
- Storefront stock badges use on-hand minus reserved and ignore expired lots; checkout's reservation does exclude expired lots, so a customer can at worst be told at checkout that an item is short.
- The stock report's rate of sale is company-wide per variant (one store today); with several locations it would need a location filter.
- No email verification for shoppers; the only emails sent are password-reset links and "password changed" notices. See docs/SECURITY.md.
- Prisma 6 → 7 upgrade pending (clears the `deepmerge-ts` CLI advisory; replaces the deprecated `package.json#prisma` config).
- Prettier is configured but the codebase is not formatted with it (`npm run format:check` fails across earlier phases too); ESLint is the enforced style check.

---

## 8. Risky assumptions (to confirm)

1. ~~Revenue at dispatch~~ → **Decided: online revenue is recognised when payment is confirmed.**
2. **Tax (decided):** the business is VAT-registered. There is a business-level `prices_include_tax` toggle (inclusive or exclusive pricing), and each product has a tax rate (standard, zero-rated or exempt). The VAT rate itself is a setting and is not hardcoded. *Assumption:* the inclusive/exclusive choice is a business setting changeable by Owner/Accountant, **not** a per-sale cashier toggle.
3. **WAC is company-wide per variant**, not per location.
4. **Batches don't carry cost** (WAC only). FEFO decides which lot is picked, not what it costs.
5. **Restocked returns come back at the original sale cost.** Damaged or expired returns are not restocked, so no inventory is restored.
6. **One legal entity and one currency (NGN)**, with no multi-currency. There is **one physical store**, which also fulfils online orders. Additional locations are supported by the schema.
7. **Credit sales are disabled by default.** They can be enabled per customer with a credit limit and require the `sales.credit` permission.
8. **File storage:** local disk behind a storage interface (S3-compatible can be added later).
9. **Out of scope for v1** unless requested: loyalty points, gift cards, promotions engine (beyond manual or authorized discounts), multi-currency, payroll, e-invoicing integrations, offline-mode POS.
