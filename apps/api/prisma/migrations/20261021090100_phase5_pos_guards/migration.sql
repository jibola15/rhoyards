-- Phase 5 integrity guards (documented in docs/DATABASE.md).

-- One open shift per register, and one per cashier.
CREATE UNIQUE INDEX "cashier_shifts_one_open_per_register" ON "cashier_shifts" ("register_id") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "cashier_shifts_one_open_per_cashier" ON "cashier_shifts" ("cashier_id") WHERE "status" = 'OPEN';

ALTER TABLE "cashier_shifts"
  ADD CONSTRAINT "cashier_shifts_amounts_chk" CHECK ("opening_float" >= 0 AND ("counted_cash" IS NULL OR "counted_cash" >= 0)),
  ADD CONSTRAINT "cashier_shifts_closed_chk" CHECK ("status" = 'OPEN' OR ("closed_at" IS NOT NULL AND "expected_cash" IS NOT NULL AND "counted_cash" IS NOT NULL AND "variance" = "counted_cash" - "expected_cash"));

ALTER TABLE "customers" ADD CONSTRAINT "customers_credit_chk" CHECK ("credit_limit" >= 0);

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_amounts_chk" CHECK (
    "gross_total" >= 0 AND "discount_total" >= 0 AND "subtotal" >= 0 AND "tax_total" >= 0 AND "total" >= 0
    AND "amount_paid" >= 0 AND "change_given" >= 0 AND "balance_due" >= 0 AND "cost_total" >= 0
  ),
  -- A completed sale is numbered, and its money adds up.
  ADD CONSTRAINT "sales_completed_chk" CHECK (
    "status" <> 'COMPLETED' OR (
      "number" IS NOT NULL AND "completed_at" IS NOT NULL
      AND "total" = "subtotal" + "tax_total"
      AND "gross_total" - "discount_total" = CASE WHEN "prices_include_tax" THEN "total" ELSE "subtotal" END
      AND "amount_paid" + "balance_due" = "total"
    )
  );

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_qty_chk" CHECK ("qty" > 0 AND "qty_returned" >= 0 AND "qty_returned" <= "qty"),
  ADD CONSTRAINT "sale_items_amounts_chk" CHECK (
    "unit_price" >= 0 AND "list_price" >= 0 AND "discount_amount" >= 0 AND "tax_rate" BETWEEN 0 AND 100
    AND "net_amount" >= 0 AND "tax_amount" >= 0 AND "line_total" = "net_amount" + "tax_amount"
    AND "unit_cost" >= 0 AND "cost_amount" >= 0
  );

ALTER TABLE "sale_payments"
  ADD CONSTRAINT "sale_payments_amount_chk" CHECK ("amount" > 0 AND "change_given" >= 0 AND ("tendered" IS NULL OR "tendered" = "amount" + "change_given"));

-- ── Completed sales are immutable ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION "sales_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text = 'COMPLETED' THEN
      RAISE EXCEPTION 'Completed sale % cannot be deleted', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status"::text = 'COMPLETED' THEN
    RAISE EXCEPTION 'Completed sale % cannot be changed; record a return instead', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sales_guard_trg" BEFORE UPDATE OR DELETE ON "sales" FOR EACH ROW EXECUTE FUNCTION "sales_guard"();

-- Items of a completed sale: only qty_returned may change (returns, Phase 8).
CREATE OR REPLACE FUNCTION "sale_items_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "sales" WHERE "id" = COALESCE(NEW."sale_id", OLD."sale_id") FOR SHARE;
  IF v_status IS DISTINCT FROM 'COMPLETED' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Items of a completed sale cannot be added or removed';
  END IF;
  IF (NEW."sale_id", NEW."line_no", NEW."variant_id", NEW."qty", NEW."unit_price", NEW."discount_amount", NEW."tax_rate",
      NEW."net_amount", NEW."tax_amount", NEW."line_total", NEW."unit_cost", NEW."cost_amount")
     IS DISTINCT FROM
     (OLD."sale_id", OLD."line_no", OLD."variant_id", OLD."qty", OLD."unit_price", OLD."discount_amount", OLD."tax_rate",
      OLD."net_amount", OLD."tax_amount", OLD."line_total", OLD."unit_cost", OLD."cost_amount") THEN
    RAISE EXCEPTION 'Items of a completed sale cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sale_items_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "sale_items" FOR EACH ROW EXECUTE FUNCTION "sale_items_guard"();

CREATE OR REPLACE FUNCTION "sale_payments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "sales" WHERE "id" = COALESCE(NEW."sale_id", OLD."sale_id") FOR SHARE;
  IF v_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'Payments of a completed sale cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "sale_payments_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "sale_payments" FOR EACH ROW EXECUTE FUNCTION "sale_payments_guard"();

-- Closed shifts are final.
CREATE OR REPLACE FUNCTION "cashier_shifts_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."status"::text = 'CLOSED' THEN
    RAISE EXCEPTION 'Shift % is closed (or shifts cannot be deleted)', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "cashier_shifts_guard_trg" BEFORE UPDATE OR DELETE ON "cashier_shifts" FOR EACH ROW EXECUTE FUNCTION "cashier_shifts_guard"();
