-- Staff usernames and two-factor sign-in, password reset links, and tables that let several API instances share
-- rate limits and run background jobs once (documented in docs/DATABASE.md).

-- CreateEnum
CREATE TYPE "LoginChallengeKind" AS ENUM ('TWO_FACTOR', 'TWO_FACTOR_SETUP', 'AUTHENTICATOR_CHANGE');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_secret_enc" TEXT,
ADD COLUMN     "username" TEXT;

-- CreateTable
CREATE TABLE "user_backup_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "LoginChallengeKind" NOT NULL,
    "pending_secret_enc" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "realm" "SessionRealm" NOT NULL,
    "user_id" UUID,
    "customer_account_id" UUID,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "reset_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "name" TEXT NOT NULL,
    "last_started_at" TIMESTAMPTZ(3),
    "last_finished_at" TIMESTAMPTZ(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "run_by" TEXT,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_backup_codes_user_id_code_hash_key" ON "user_backup_codes"("user_id", "code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "login_challenges_user_id_idx" ON "login_challenges"("user_id");

-- CreateIndex
CREATE INDEX "login_challenges_expires_at_idx" ON "login_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_customer_account_id_idx" ON "password_reset_tokens"("customer_account_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "rate_limits_reset_at_idx" ON "rate_limits"("reset_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "user_backup_codes" ADD CONSTRAINT "user_backup_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_customer_account_id_fkey" FOREIGN KEY ("customer_account_id") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Guards ─────────────────────────────────────────────────────────────────
-- Usernames are stored lower case, cannot look like an email (so a sign-in name is never ambiguous).
ALTER TABLE "users" ADD CONSTRAINT "users_username_chk" CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
-- Two-factor is either fully set up (secret + date) or not at all.
ALTER TABLE "users" ADD CONSTRAINT "users_totp_chk" CHECK (("totp_secret_enc" IS NULL) = ("totp_enabled_at" IS NULL));
-- A reset link belongs to exactly one account of its realm.
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_owner_chk" CHECK (
  ("realm" = 'STAFF' AND "user_id" IS NOT NULL AND "customer_account_id" IS NULL)
  OR ("realm" = 'CUSTOMER' AND "customer_account_id" IS NOT NULL AND "user_id" IS NULL)
);
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_attempts_chk" CHECK ("attempts" >= 0);
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_secret_chk" CHECK (("kind" = 'TWO_FACTOR') = ("pending_secret_enc" IS NULL));
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_hits_chk" CHECK ("hits" >= 0);
