# Security

The controls in place, what the Phase 10 review checked, and the risks accepted for v1.

## Controls

| Area | Control |
|---|---|
| Staff sign-in | argon2id password hashes; minimum 10 characters; lockout after 5 failures for 15 minutes; per-IP rate limit; constant-time response for unknown emails; forced password change for new and reset accounts |
| Customer sign-in | separate `customer_accounts`, own cookie (`rh_cid`) and sessions (realm CUSTOMER); same hashing, lockout and rate limit; minimum 8 characters |
| Sessions | random 256-bit tokens, only the SHA-256 stored; HttpOnly, SameSite=Lax, `__Host-` + Secure in production; idle and absolute expiry; revoked on logout, password change, reset and disabling a user; expired sessions purged hourly |
| CSRF | synchronizer token per session in a header (held in memory by the front ends), plus an Origin check on state-changing requests |
| Authorisation | permission checked on every route on the server; role edits cannot grant permissions the editor lacks; owners protected from lock-out; the system user can never sign in and is hidden from staff screens |
| Input | Zod validation on every body, query and parameter; parameterised SQL only (Prisma and tagged raw queries); allow-listed sort and group-by fields |
| Money and stock integrity | database triggers and CHECK constraints: balanced, immutable journals; append-only stock and audit ledgers; final documents cannot change; refund and stock caps; `Idempotency-Key` on every money-moving request |
| Payments | webhooks verified by HMAC over the raw body, stored before processing, unique per event id; amounts checked; browser redirects never mark orders paid; the test gateway cannot run in production |
| Files | size limit; type decided by content (magic bytes), not name; images re-encoded server-side (metadata and polyglots stripped); PDFs served as downloads; private files only to staff with an expenses permission |
| HTTP | helmet headers; API responses carry `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`; `nosniff`; HSTS; no `X-Powered-By`; strict CORS allow-list with credentials; JSON bodies limited to 1 MB |
| Errors and logs | one error envelope with a request id; no stack traces or SQL to clients; structured logs; audit log of every change (append-only) |
| Exports | CSV cells that a spreadsheet would run as a formula are neutralised |

## Phase 10 review

| Finding | Action |
|---|---|
| `sharp` (image processing) had high-severity advisories in bundled libvips/libheif/librsvg | **Fixed**: upgraded to 0.35.5. HEIF and SVG were already unreachable (rejected by content type before decoding) |
| `deepmerge-ts` advisory via the Prisma CLI's config loader | **Accepted**: only Prisma's own configuration is merged, never request data; the fix needs Prisma 7 (major upgrade, planned) |
| API responses used helmet's default CSP (written for HTML pages) | **Fixed**: API sends `default-src 'none'`; the development Swagger page keeps the default |
| With `TRUST_PROXY=0` behind a proxy, rate limits and audit IPs would apply to the proxy, not clients | **Fixed**: start-up warning in production; documented in the deployment guide |
| Expired sessions and idempotency keys accumulated | **Fixed**: hourly housekeeping job |
| `.env.example` enabled Swagger UI; copying it to production would publish the API description | **Fixed**: commented out; production default is off |
| Some routes missing from the OpenAPI document | **Fixed**, and a test now fails if any served route is undocumented |
| Recharts was preloaded on every back-office page | **Fixed**: loaded only with the dashboard |

## Accepted risks and limits (v1)

- **Single API instance.** Rate-limit counters and background jobs are in memory; running more instances needs a shared store (e.g. Redis) and a single job runner.
- **No staff two-factor sign-in.** Recommended next step for owner and accountant accounts.
- **No customer password reset or email verification** (no email service yet). Registration reveals whether an email already has an account (the usual trade-off for a clear sign-up error).
- **PDF receipts are stored as uploaded** (after a content check). They are private, served only as downloads with `nosniff`, and never rendered on our origin.
- **Front-end CSP allows inline style attributes** (`style-src 'unsafe-inline'`), needed by React style props and the charts; scripts remain `'self'` only.
- **Uploads on local disk.** Use a persistent, backed-up volume; an S3-compatible driver can replace it behind the `FileStorage` interface.

## Reporting a problem

Report suspected vulnerabilities privately to the system owner. Do not open a public issue with details.
