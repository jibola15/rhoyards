# Rhoyards — Cosmetics & Beauty Supply Management System

Inventory, in-store POS, online store, purchasing, expenses and double-entry accounting for a cosmetics retailer with one physical store and an online shop.

> **Status:** Phase 1 (project setup) complete. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the roadmap and decisions log.

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
- A Neon PostgreSQL project (required from Phase 2 — not needed to run Phase 1)

## Getting started

```bash
npm install
cp apps/api/.env.example apps/api/.env   # PowerShell: Copy-Item apps/api/.env.example apps/api/.env
npm run dev
```

`npm run dev` starts the API (port 4000) and both Vite dev servers. The Vite servers proxy `/api` to the API, so the browser always talks same-origin.

## Scripts (run from the repo root)

| Command | Purpose |
|---|---|
| `npm run dev` | API + back office + storefront in watch mode |
| `npm run build` | Production builds of all workspaces |
| `npm run typecheck` | TypeScript checks in every workspace |
| `npm run lint` | ESLint (flags `parseFloat` in money-handling code) |
| `npm test` | All Vitest projects (shared, api, backoffice, storefront) |
| `npm run check` | typecheck + lint + test |

## Conventions

- **Money** is never a JavaScript `number`. Use `Decimal` helpers from `@rhoyards/shared`; the API sends money as strings (`"12500.00"`). See the plan, section 3.
- **Responses:** `{ data, meta? }` on success, `{ error: { code, message, details?, requestId } }` on failure.
- **Secrets** live only in `apps/api/.env` (git-ignored). Never commit real credentials or customer data.

## Documentation

- [Implementation plan & decisions](docs/IMPLEMENTATION_PLAN.md)
- [Architecture](docs/ARCHITECTURE.md)
- API reference: run the API and open http://localhost:4000/api/docs
