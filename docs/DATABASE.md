# Database

PostgreSQL on **Neon** (London, `eu-west-2`), accessed only by the API through Prisma 6.
Schema source: [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma). Tables are added phase by phase; the full target design is in [IMPLEMENTATION_PLAN.md §4](IMPLEMENTATION_PLAN.md).

## Environments

| Purpose | Database | Connection |
|---|---|---|
| Development | `neondb` | `DATABASE_URL` (pooled, `pgbouncer=true`) for the app; `DIRECT_URL` for migrations |
| Automated tests | `rhoyards_test` | `TEST_DATABASE_URL` / `TEST_DIRECT_URL` — **truncated by the test suite** |
| Production | its own Neon branch or project | as development; app connects with a DML-only role (Phase 10) |

> **Isolation rule.** Tests must use a **separate database**, never a separate schema of the same database.
> Behind Neon's PgBouncer pooler, the `search_path` set by Prisma's `?schema=` parameter can carry over between
> pooled server connections — during Phase 2 this caused a test-suite `TRUNCATE` to empty the development schema.
> The test harness now refuses to run unless the database name contains `test`, rejects `?schema=` in test URLs,
> and `resetDatabase()` re-checks `current_database()` on the same connection immediately before truncating.

## Commands (run in `apps/api`, or with `-w @rhoyards/api` from the root)

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply pending migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Idempotent reference data + first owner account |
| `npm run db:setup` | Both of the above |
| `npm run db:seed:demo` | Fictional demo catalogue, suppliers and posted opening stock (development only; refuses in production) |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:diff` | Print SQL needed to bring the live database in line with `schema.prisma` |

### Creating a migration

`prisma migrate dev` needs a shadow database, which is awkward on Neon. Instead:

1. Edit `schema.prisma`.
2. `npm run db:diff > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` (review it).
3. Append any raw SQL the change needs (CHECKs, triggers, partial indexes).
4. `npm run db:migrate`, then `npm test` (the test database is migrated automatically).

## Conventions

- UUID primary keys (`gen_random_uuid()` via Prisma `uuid()`), snake_case tables and columns, `timestamptz(3)`.
- Money `NUMERIC(18,2)`; unit costs `NUMERIC(18,4)`; quantities `NUMERIC(14,3)`; rates `NUMERIC(7,4)`. Never floating point.
- `ON DELETE RESTRICT` for anything referenced by history. Users, roles in use, accounts and locations are deactivated, not deleted.
- Every money/stock/accounting change runs in one interactive transaction (`transaction()` in `src/lib/prisma.ts`) and writes its audit record inside that transaction.

## Tables

| Phase | Area | Tables |
|---|---|---|
| 2 | Identity & security | `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `user_locations`, `sessions`, `audit_logs` |
| 2 | Configuration | `settings` (one JSON row per section), `tax_rates`, `document_sequences`, `idempotency_keys` |
| 2 | Locations | `locations` |
| 2 | Accounting core | `accounts`, `fiscal_years`, `accounting_periods`, `journal_entries`, `journal_lines` |
| 3 | Files | `files` (server-generated storage key, SHA-256, visibility) |
| 3 | Catalogue | `brands`, `categories` (tree), `units`, `products`, `product_variants`, `variant_barcodes`, `product_images` |
| 3 | Suppliers | `suppliers` |
| 3 | Inventory | `inventory_balances` (variant × location), `inventory_batches` (lots), `stock_movements` (ledger), `stock_adjustments` + `_lines`, `stock_transfers` + `_lines` |

### Inventory model

- `product_variants.stock_qty` / `stock_value` are company-wide totals kept by the inventory engine; `avg_cost` = value ÷ qty (moving weighted average). Invariants, checked by the test suite:
  - Σ `inventory_balances.qty_on_hand` per variant = `stock_qty` − quantity in transit on dispatched transfers;
  - Σ `stock_movements.total_cost` (excluding transfer movements) per variant = `stock_value`;
  - Σ `stock_value` over all variants = balance of the `INVENTORY` ledger account (`GET /inventory/valuation` reports the difference).
- Batch/expiry-tracked products hold their stock in `inventory_batches`; lot quantities never go negative. Expiry-tracked always implies batch-tracked. A lot without a number is named `EXP-YYYY-MM-DD` from its expiry date.
- Every stock change takes row locks via `openStockSession()`: variant rows first (`FOR UPDATE`, ordered by id), then balance rows (ordered by variant, location).

## Integrity guards in the database

Defined in `prisma/migrations/20261018120100_phase2_integrity_guards/migration.sql`. They hold even if application code is wrong.

| Guard | Rule |
|---|---|
| `journal_lines_amounts_chk` | `debit >= 0`, `credit >= 0`, exactly one of them non-zero |
| `journal_entries_guard_trg` | entries are inserted as `DRAFT`; moving to `POSTED` requires ≥ 2 lines, Σdebit = Σcredit > 0, an `OPEN` period containing the entry date, and sets the totals; `POSTED` entries can never be updated or deleted |
| `journal_lines_guard_trg` | lines of a posted entry cannot be inserted, updated or deleted; lines must hit active, postable accounts; takes `FOR SHARE` on the entry to serialise against a concurrent post |
| `journal_entries.posting_key` UNIQUE | the same business event cannot be posted twice |
| `journal_entries.reversal_of_id` UNIQUE | an entry can be reversed at most once |
| `audit_logs_append_only_trg` | audit rows cannot be updated or deleted |
| `tax_rates_rate_chk` | 0 ≤ rate ≤ 100, and zero-rated/exempt rates must be 0 |
| `users_email_lower_chk` | emails stored lower-case (case-insensitive uniqueness) |
| `stock_movements_append_only_trg` | the stock ledger cannot be updated or deleted |
| `stock_movements_qty_chk` / `_cost_chk` | movements are non-zero; unit cost ≥ 0 |
| `inventory_batches_qty_chk` | a lot can never hold negative stock |
| `inventory_balances_reserved_chk` | reserved quantity ≥ 0 (on-hand may go negative only via the authorised negative-stock path) |
| `stock_adjustments_guard_trg` / `stock_transfers_guard_trg` | POSTED / RECEIVED / CANCELLED documents cannot be changed or deleted |
| `stock_adjustment_lines_guard_trg` / `stock_transfer_lines_guard_trg` | lines can change only while the document is DRAFT |
| `product_variants_sku_chk` / `_prices_chk` / `_reorder_chk` | SKU format (upper-case); prices, costs and reorder levels ≥ 0 |
| `products_expiry_needs_batch_chk` | expiry tracking requires batch tracking |

## Sessions

`sessions` stores only the SHA-256 hash of the random session token, plus the CSRF token, idle and absolute expiry. Revocation sets `revoked_at`; logout, password change, password reset and disabling a user all revoke.

## Seed data

`prisma/seed/base.ts` creates (only if missing): the permission catalogue, six system roles with default permissions, the chart of accounts, VAT (7.5 %, editable) / zero-rated / exempt tax rates, default settings (NGN, prices include VAT), units of measure (PC, SET, PACK, ML, L, G, KG), the `MAIN` store location and the current fiscal year with 12 monthly periods. `prisma/seed.ts` additionally creates the first owner from `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` with a forced password change. No real customer data is seeded.
