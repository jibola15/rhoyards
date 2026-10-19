# Rhoyards — Cosmetics & Beauty Supply Management System

Inventory, in-store POS, online store, purchasing, expenses and double-entry accounting for a cosmetics retailer with one physical store and an online shop.

> **Status:** all ten phases complete — ready for a first production deployment (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). Back office: catalogue and stock, purchasing, point of sale, online orders, returns and refunds, customers and payments, expenses, accounting with period and year-end close, financial statements, reconciliation, dashboard and reports, audit log; staff sign in with email or username plus a required authenticator-app code, and reset forgotten passwords by email. Storefront: catalogue, cart, customer accounts, checkout with stock reservations shared with the till, bank-transfer and card-gateway payments, order tracking, password reset. The API can run as several instances behind a load balancer. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the roadmap and decisions log.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | Express + TypeScript REST API (`/api/v1`), Swagger UI at `/api/docs` |
| `apps/backoffice` | React back office: admin, POS, reports — http://localhost:5173 |
| `apps/storefront` | React online store — http://localhost:5174 |
| `packages/shared` | Zod schemas, API contracts, Decimal money helpers, typed API client |
| `packages/ui` | Design tokens (Tailwind v4) and shadcn/ui-style components |
| `docs/` | Plan, architecture, database and accounting documentation |

## Requirements

- Node.js 22+ and npm 10+
- A Neon PostgreSQL project with **two databases**: one for development and one whose name contains `test` (e.g. `rhoyards_test`) for the automated tests. See [docs/DATABASE.md](docs/DATABASE.md).

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env   # PowerShell: Copy-Item apps/api/.env.example apps/api/.env
# fill in DATABASE_URL, DIRECT_URL, TEST_DATABASE_URL, TEST_DIRECT_URL, SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD
npm run db:setup -w @rhoyards/api        # migrations + reference data + first owner account
npm run db:seed:demo -w @rhoyards/api    # optional: fictional demo products, suppliers and opening stock
npm run dev
```

`npm run dev` starts the API (port 4000) and both Vite dev servers. The Vite servers proxy `/api` to the API, so the browser always talks same-origin. Open http://localhost:5173 and sign in with the seeded owner; you will be asked to choose a new password.

## Scripts (run from the repo root)

| Command | Purpose |
|---|---|
| `npm run dev` | API + back office + storefront in watch mode |
| `npm run build` | Production builds of all workspaces |
| `npm run typecheck` | TypeScript checks in every workspace |
| `npm run lint` | ESLint (flags `parseFloat` in money-handling code) |
| `npm test` | All Vitest projects (shared, api, backoffice, storefront). API integration tests run against the test database and take several minutes over the network |
| `npx vitest run --project backoffice` | Run a single project |
| `npm run check` | typecheck + lint + test |
| `npm run e2e` | End-to-end browser tests (Playwright, Chromium): starts the API on the **test** database (reset and seeded) and both front ends on ports 4100/5273/5274. First time: `npx playwright install chromium` |

## Conventions

- **Money** is never a JavaScript `number`. Use `Decimal` helpers from `@rhoyards/shared`; the API sends money as strings (`"12500.00"`). See the plan, section 3.
- **Responses:** `{ data, meta? }` on success, `{ error: { code, message, details?, requestId } }` on failure.
- **Secrets** live only in `apps/api/.env` (git-ignored). Never commit real credentials or customer data.

## Documentation

- [Implementation plan & decisions](docs/IMPLEMENTATION_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Database](docs/DATABASE.md)
- [Accounting rules](docs/ACCOUNTING_RULES.md)
- [Online payments](docs/PAYMENTS.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Security](docs/SECURITY.md)
- API reference: run the API and open http://localhost:4000/api/docs
