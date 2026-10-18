-- Integrity guards that Prisma cannot model. Documented in docs/DATABASE.md.
-- Object names are unqualified so the migration applies to whichever schema is on the search_path.

-- ── CHECK constraints ────────────────────────────────────────────────────────

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amounts_chk"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND (("debit" = 0) <> ("credit" = 0)));

ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_totals_chk" CHECK ("total_debit" >= 0 AND "total_credit" >= 0),
  ADD CONSTRAINT "journal_entries_not_self_reversal_chk" CHECK ("reversal_of_id" IS NULL OR "reversal_of_id" <> "id");

ALTER TABLE "tax_rates"
  ADD CONSTRAINT "tax_rates_rate_chk"
  CHECK ("rate" >= 0 AND "rate" <= 100 AND ("kind" = 'STANDARD' OR "rate" = 0));

ALTER TABLE "fiscal_years" ADD CONSTRAINT "fiscal_years_dates_chk" CHECK ("end_date" >= "start_date");
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_dates_chk" CHECK ("end_date" >= "start_date");
ALTER TABLE "users" ADD CONSTRAINT "users_email_lower_chk" CHECK ("email" = lower("email"));
ALTER TABLE "users" ADD CONSTRAINT "users_failed_login_chk" CHECK ("failed_login_count" >= 0);
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_next_chk" CHECK ("next_value" >= 1 AND "padding" BETWEEN 1 AND 12);

-- ── Journal entry lifecycle ──────────────────────────────────────────────────
-- * entries are inserted as DRAFT, lines added, then UPDATEd to POSTED
-- * posting requires >= 2 lines, debits = credits > 0, an OPEN period containing the entry date
-- * POSTED entries can never be updated or deleted (corrections are reversals)

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
      FROM "accounting_periods" WHERE "id" = NEW."period_id";
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

CREATE TRIGGER "journal_entries_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "journal_entries_guard"();

-- Lines of a posted entry cannot be inserted, changed or deleted, and must hit postable, active accounts.
-- FOR SHARE on the parent serialises line changes against a concurrent posting UPDATE.
CREATE OR REPLACE FUNCTION "journal_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_postable boolean;
  v_active   boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT "status"::text INTO v_status FROM "journal_entries" WHERE "id" = OLD."entry_id" FOR SHARE;
    IF v_status = 'POSTED' THEN
      RAISE EXCEPTION 'Lines of posted journal entry % cannot be changed', OLD."entry_id";
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  SELECT "status"::text INTO v_status FROM "journal_entries" WHERE "id" = NEW."entry_id" FOR SHARE;
  IF v_status = 'POSTED' THEN
    RAISE EXCEPTION 'Lines cannot be added to posted journal entry %', NEW."entry_id";
  END IF;

  SELECT "is_postable", "is_active" INTO v_postable, v_active FROM "accounts" WHERE "id" = NEW."account_id";
  IF NOT COALESCE(v_postable, false) OR NOT COALESCE(v_active, false) THEN
    RAISE EXCEPTION 'Account % is not an active postable account', NEW."account_id";
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "journal_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "journal_lines_guard"();

-- ── Append-only tables ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION "forbid_update_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows in % are append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "audit_logs_append_only_trg"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
