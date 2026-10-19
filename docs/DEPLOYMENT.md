# Deployment guide

How to run Rhoyards in production. One or more API processes, two static front ends, one PostgreSQL database (Neon), an SMTP account for email, behind a reverse proxy with TLS.

```
                       ┌──────────────── reverse proxy (TLS, security headers) ────────────────┐
 staff  ── https ──►   │ admin.example.com  → apps/backoffice/dist (static)   /api/* → API :4000 │
 public ── https ──►   │ shop.example.com   → apps/storefront/dist (static)   /api/* → API :4000 │
                       └───────────────────────────────────────────────────────────────────────┘
                                                    │
                                     node apps/api/dist/server.js  ──►  Neon PostgreSQL
                                     (1..n instances; uploads on a shared disk) ──►  SMTP
```

Each front end calls `/api` on its **own** origin, so session cookies stay first-party and host-only: the staff cookie lives on the admin host, the customer cookie on the shop host.

## 1. Requirements

- Node.js 22 LTS on the server (the API bundle targets Node 22).
- A Neon project with a **production database** (not the development or test one), a least-privilege role for the API and a separate role for migrations. Point-in-time restore enabled.
- A persistent directory for uploaded files (product photos, expense receipts), backed up.
- Two host names with TLS certificates (Caddy obtains them automatically).
- An **SMTP account** for outgoing email (password-reset links). Any provider works (Mailgun, SendGrid, Amazon SES, Postmark, Microsoft 365, …); the sender address should be on a domain with SPF and DKIM set up.
- **One API instance or several.** Several copies can run behind a load balancer (for availability or load): rate-limit counters live in the database (`rate_limits`), and each background job (releasing expired online-order reservations every minute, hourly housekeeping) runs on only one instance at a time, once per interval, coordinated through a PostgreSQL advisory lock and the `scheduled_jobs` table. Sessions, idempotency keys and sign-in challenges are already in the database, so no sticky sessions are needed. With several instances, `UPLOAD_DIR` must be **shared** by all of them (a network volume), or replaced by an object-storage driver.

## 2. Configuration (`apps/api/.env` or the service manager's environment)

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (enables `__Host-` secure cookies; refuses the test payment gateway) |
| `PORT` | `4000` (only the proxy should reach it) |
| `LOG_LEVEL` | `info` |
| `DATABASE_URL` | Neon **pooled** URL for the API role (`…-pooler…/rhoyards?sslmode=require`) |
| `DIRECT_URL` | Neon **direct** URL for the migration role (migrations only) |
| `CORS_ORIGINS` | `https://admin.example.com,https://shop.example.com` |
| `TRUST_PROXY` | number of proxies in front of the API, usually `1`. **Required**: with `0` every client shares the proxy's IP for rate limits and audit logs (the API logs a warning at start-up) |
| `API_DOCS_ENABLED` | leave unset (off in production) |
| `SESSION_IDLE_MINUTES` / `SESSION_ABSOLUTE_HOURS` | staff sessions; defaults 30 / 12 |
| `LOGIN_RATE_LIMIT` | sign-in attempts per IP per 15 minutes; default 10 (also used for password-reset requests; code attempts get twice this) |
| `RATE_LIMIT_STORE` | leave unset: `database` in production (counters shared by every instance). `memory` only for a single instance that must avoid the extra query per request |
| `TWO_FACTOR_KEY` | **required**: 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts staff authenticator secrets. Keep it with the database backups' secrets: losing it means every staff member must set up their authenticator again (an owner resets them under Staff users) |
| `BACKOFFICE_URL` / `STOREFRONT_URL` | **required**, `https://admin.example.com` / `https://shop.example.com`: the links in password-reset emails |
| `SMTP_HOST` / `SMTP_PORT` | **required** host; port `587` (STARTTLS, required) or `465` (TLS) |
| `SMTP_SECURE` | leave unset (derived from the port) |
| `SMTP_USER` / `SMTP_PASS` | the provider's SMTP credentials (both or neither) |
| `MAIL_FROM` | **required**, e.g. `Rhoyards <no-reply@example.com>` |
| `UPLOAD_DIR` | absolute path on the persistent disk, e.g. `/var/lib/rhoyards/uploads` |
| `MAX_UPLOAD_MB` | default 5; keep the proxy's request-size limit a little above it |
| `BUSINESS_TIMEZONE` | `Africa/Lagos` (defines the business day for journal dates) |
| `PAYMENT_TEST_ENABLED` | leave unset (the sandbox gateway cannot run in production) |
| `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` | only for the first `db:seed`; remove afterwards |

Keep the file readable only by the service user. Never commit it.

## 3. Build

```bash
npm ci
npm run build          # prisma generate + API bundle (apps/api/dist/server.js) + both front ends (apps/*/dist)
```

The API bundle includes the workspace code; Prisma Client, argon2 and sharp stay in `node_modules`, so deploy with the installed `node_modules` (or run `npm ci` on the server). On Windows, stop any running dev server first: Prisma cannot replace its engine file while another process has it open.

## 4. Database

```bash
npm run db:migrate -w @rhoyards/api     # prisma migrate deploy, uses DIRECT_URL; run before every new version starts
npm run db:seed -w @rhoyards/api        # first install only: roles, chart of accounts, settings, the owner from SEED_OWNER_*
```

Migrations also install the database guards (triggers and CHECK constraints) that keep the ledger, stock and documents consistent even if application code is wrong. Never apply schema changes by hand.

At the first sign-in the owner sets up an authenticator app (two-step sign-in is required for every staff account), saves the backup codes and changes the password. Then set the business details, VAT registration and pricing mode, payment methods, delivery options, bank-transfer instructions and opening balances (Accounting → Opening balances; opening stock as an opening-stock adjustment).

## 5. Run the API

Under a process manager that restarts it and passes `SIGTERM` for a graceful shutdown (the API drains connections for up to 10 seconds). Example systemd unit:

```ini
[Unit]
Description=Rhoyards API
After=network-online.target

[Service]
User=rhoyards
WorkingDirectory=/srv/rhoyards
EnvironmentFile=/etc/rhoyards/api.env
ExecStart=/usr/bin/node apps/api/dist/server.js
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/rhoyards/uploads

[Install]
WantedBy=multi-user.target
```

Health check: `GET /api/v1/health` → `200 {"data":{"status":"ok",…}}`. Logs are JSON lines (pino) on stdout, with a request id on every line and in every error response.

## 6. Reverse proxy (Caddy example)

```caddy
(security) {
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		# Built pages load only their own script and style files; React and the charts set style attributes.
		Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
		-Server
	}
}

admin.example.com {
	import security
	request_body /api/* { max_size 6MB }
	handle /api/* { reverse_proxy 127.0.0.1:4000 }
	handle {
		root * /srv/rhoyards/apps/backoffice/dist
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		try_files {path} /index.html
		file_server
	}
}

shop.example.com {
	import security
	request_body /api/* { max_size 1MB }
	handle /api/* { reverse_proxy 127.0.0.1:4000 }
	handle {
		root * /srv/rhoyards/apps/storefront/dist
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
		try_files {path} /index.html
		file_server
	}
}
```

Caddy sets `X-Forwarded-For`, so `TRUST_PROXY=1`. The API adds its own strict headers to API responses (`default-src 'none'`, `frame-ancestors 'none'`, HSTS, `nosniff`). Optionally block `/api/v1/store/*` on the admin host and everything but `/api/v1/store/*`, `/api/v1/files/*` and `/api/v1/webhooks/*` on the shop host.

## 7. Payments

- Bank transfer works out of the box: put the account details in Settings → Online store.
- Card payments need a real provider plugged into the payment interface (see [PAYMENTS.md](PAYMENTS.md)); its webhook URL will be `https://shop.example.com/api/v1/webhooks/payments/<provider>`.

## 8. Backups and recovery

- **Database:** Neon point-in-time restore; also take a scheduled `pg_dump` of the production database to separate storage, and test a restore.
- **Uploads:** back up `UPLOAD_DIR` with the database backup (files are referenced by id from the `files` table).
- After a restore, run `GET /api/v1/inventory/valuation` and the trial balance: stock value must equal Inventory and the trial balance must balance.

## 9. Release checklist

- [ ] `npm run check` (typecheck, lint, unit and integration tests against the test database) and `npm run e2e` pass
- [ ] `npm audit --omit=dev` reviewed (see [SECURITY.md](SECURITY.md) for accepted items)
- [ ] `NODE_ENV=production`, `TRUST_PROXY` set, `API_DOCS_ENABLED` and `PAYMENT_TEST_ENABLED` unset, `SEED_OWNER_*` removed
- [ ] `TWO_FACTOR_KEY` generated and stored safely; SMTP settings, `MAIL_FROM`, `BACKOFFICE_URL` and `STOREFRONT_URL` set; a "Forgot password" email arrives and its link opens the right site
- [ ] With several instances: `UPLOAD_DIR` is shared, and the load balancer health-checks `/api/v1/health/ready`
- [ ] Migrations applied before the new API version starts
- [ ] Health check green; sign in to the back office; open the dashboard; place a test order with a bank transfer and cancel it
- [ ] Backups configured and a restore tested
