-- Phase 6: accounting (documented in docs/DATABASE.md).

ALTER TABLE "fiscal_years" ADD COLUMN "closed_at" TIMESTAMPTZ(3), ADD COLUMN "closed_by_id" UUID;

-- ── Posting re-checks the period under a share lock ─────────────────────────
-- Same rules as Phase 2; the period row is now read FOR SHARE, so a posting and a period close
-- (which locks the period FOR UPDATE) serialise and an entry can never land in a just-closed period.
CREATE OR REPLACE FUNCTION "journal_entries_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debit  numeric(18, 2);
  v_credit numeric(18, 2);
  v_lines  integer;
  v_status text;
  v_start  date;
  v_end    date;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text = 'POSTED' THEN
      RAISE EXCEPTION 'Posted journal entry % cannot be deleted', OLD."id";
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text = 'POSTED' THEN
      RAISE EXCEPTION 'Journal entries must be created as DRAFT and then posted';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status"::text = 'POSTED' THEN
    RAISE EXCEPTION 'Posted journal entry % is immutable; post a reversal instead', OLD."id";
  END IF;

  IF NEW."status"::text = 'POSTED' THEN
    SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*)
      INTO v_debit, v_credit, v_lines
      FROM "journal_lines" WHERE "entry_id" = NEW."id";

    IF v_lines < 2 THEN
      RAISE EXCEPTION 'Journal entry % needs at least two lines', NEW."id";
    END IF;
    IF v_debit <> v_credit OR v_debit = 0 THEN
      RAISE EXCEPTION 'Journal entry % is unbalanced: debits %, credits %', NEW."id", v_debit, v_credit;
    END IF;

    SELECT "status"::text, "start_date", "end_date" INTO v_status, v_start, v_end
      FROM "accounting_periods" WHERE "id" = NEW."period_id" FOR SHARE;
    IF v_status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'Accounting period for journal entry % is closed', NEW."id";
    END IF;
    IF NEW."entry_date" < v_start OR NEW."entry_date" > v_end THEN
      RAISE EXCEPTION 'Entry date % is outside its accounting period', NEW."entry_date";
    END IF;

    NEW."total_debit" := v_debit;
    NEW."total_credit" := v_credit;
    IF NEW."posted_at" IS NULL THEN
      NEW."posted_at" := now();
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── Fiscal years and periods ────────────────────────────────────────────────
-- Dates never move once created; a closed fiscal year is final, and its periods cannot be reopened.
CREATE OR REPLACE FUNCTION "fiscal_years_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."start_date" <> OLD."start_date" OR NEW."end_date" <> OLD."end_date" THEN
    RAISE EXCEPTION 'Fiscal year dates cannot be changed';
  END IF;
  IF OLD."status"::text = 'CLOSED' AND NEW."status"::text <> 'CLOSED' THEN
    RAISE EXCEPTION 'Fiscal year % is closed and cannot be reopened', OLD."name";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "fiscal_years_guard_trg" BEFORE UPDATE ON "fiscal_years"
  FOR EACH ROW EXECUTE FUNCTION "fiscal_years_guard"();

CREATE OR REPLACE FUNCTION "accounting_periods_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year_status text;
BEGIN
  IF NEW."start_date" <> OLD."start_date" OR NEW."end_date" <> OLD."end_date" OR NEW."fiscal_year_id" <> OLD."fiscal_year_id" THEN
    RAISE EXCEPTION 'Accounting period dates cannot be changed';
  END IF;
  IF NEW."status" <> OLD."status" THEN
    SELECT "status"::text INTO v_year_status FROM "fiscal_years" WHERE "id" = NEW."fiscal_year_id";
    IF v_year_status = 'CLOSED' THEN
      RAISE EXCEPTION 'Period % belongs to a closed fiscal year', OLD."name";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_periods_guard_trg" BEFORE UPDATE ON "accounting_periods"
  FOR EACH ROW EXECUTE FUNCTION "accounting_periods_guard"();

-- ── Accounts ────────────────────────────────────────────────────────────────
-- An account with postings keeps its type and stays postable; a system key is permanent;
-- system accounts cannot be deleted.
CREATE OR REPLACE FUNCTION "accounts_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."system_key" IS NOT NULL THEN
      RAISE EXCEPTION 'System account % cannot be deleted', OLD."code";
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."system_key" IS NOT NULL AND NEW."system_key" IS DISTINCT FROM OLD."system_key" THEN
    RAISE EXCEPTION 'The system key of account % cannot be changed', OLD."code";
  END IF;
  IF (NEW."type" <> OLD."type" OR (OLD."is_postable" AND NOT NEW."is_postable"))
     AND EXISTS (SELECT 1 FROM "journal_lines" WHERE "account_id" = OLD."id") THEN
    RAISE EXCEPTION 'Account % has postings: its type cannot change and it must stay postable', OLD."code";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounts_guard_trg" BEFORE UPDATE OR DELETE ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION "accounts_guard"();

-- Reports filter posted lines by date; this keeps those scans index-only on the entry side.
CREATE INDEX "journal_entries_status_entry_date_idx" ON "journal_entries" ("status", "entry_date");
