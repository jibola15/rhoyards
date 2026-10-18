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
5. Rate limiter on `/api` (300 req/min per IP; stricter per-route limiters are added for auth, checkout and webhooks).
6. OpenAPI: `/api/openapi.json` and Swagger UI at `/api/docs` (off by default in production).
7. Routers under `/api/v1`.
8. 404 handler and central error handler.

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
- Back office shell: collapsible sidebar (collapsed state remembered per browser), off-canvas navigation on mobile (Escape closes), top bar, light/dark theme, skip-to-content link. Navigation lists only implemented routes.
- API calls go through `createApiClient` (`packages/shared`): same-origin `/api/v1`, `credentials: 'include'`, CSRF header on state-changing requests (token source wired in Phase 2), typed `ApiError` from the error envelope.

## Testing

`vitest.config.ts` at the root runs each workspace as a project:

| Project | Environment | Covers |
|---|---|---|
| shared | node | Decimal rounding/tax maths, API client |
| api | node | Supertest against `createApp()` — envelopes, request IDs, security headers, body limits, OpenAPI, env validation |
| backoffice | jsdom | Layout, navigation, theme, system status (loading / error / retry) |
| storefront | jsdom | Routing and layout |

Database integration tests (from Phase 2) run against a dedicated Neon `test` branch.
