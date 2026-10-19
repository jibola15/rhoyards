-- Phase 8 integrity guards (documented in docs/DATABASE.md).

-- ── Sales: only the settled amount moves after completion ──────────────────
ALTER TABLE "sales" ADD CONSTRAINT "sales_settled_chk" CHECK ("amount_settled" >= 0 AND "amount_settled" <= "balance_due");

CREATE OR REPLACE FUNCTION "sales_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text = 'COMPLETED' THEN
      RAISE EXCEPTION 'Completed sale % cannot be deleted', OLD."number";
    END IF;
    RETURN OLD;
  END IF;
  -- A completed sale is frozen, except how much of its credit balance has been settled (receipts, returns).
  IF OLD."status"::text = 'COMPLETED'
     AND (to_jsonb(NEW) - 'amount_settled' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'amount_settled' - 'updated_at') THEN
    RAISE EXCEPTION 'Completed sale % cannot be changed; record a return instead', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;

-- ── Online orders: REFUNDED is a paid, final state ──────────────────────────
ALTER TABLE "online_orders" DROP CONSTRAINT "online_orders_payment_chk";
ALTER TABLE "online_orders" ADD CONSTRAINT "online_orders_payment_chk" CHECK (
  ("status" IN ('PAID', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED', 'REFUNDED')) = ("sale_id" IS NOT NULL)
  AND ("status" <> 'ON_HOLD' OR "deposit_journal_id" IS NOT NULL)
  AND ("deposit_refund_journal_id" IS NULL OR "deposit_journal_id" IS NOT NULL)
  AND ("reservation_status" <> 'ACTIVE' OR "status" = 'PENDING_PAYMENT')
);

CREATE OR REPLACE FUNCTION "online_orders_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Online orders cannot be deleted';
  END IF;
  IF (NEW."number", NEW."customer_id", NEW."location_id", NEW."prices_include_tax", NEW."shipping_fee", NEW."shipping_net",
      NEW."shipping_tax", NEW."items_total", NEW."subtotal", NEW."tax_total", NEW."total")
     IS DISTINCT FROM
     (OLD."number", OLD."customer_id", OLD."location_id", OLD."prices_include_tax", OLD."shipping_fee", OLD."shipping_net",
      OLD."shipping_tax", OLD."items_total", OLD."subtotal", OLD."tax_total", OLD."total") THEN
    RAISE EXCEPTION 'The amounts of order % are fixed at checkout', OLD."number";
  END IF;
  IF OLD."status"::text IN ('CANCELLED', 'DELIVERED', 'REFUNDED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Order % is % and cannot change status', OLD."number", OLD."status";
  END IF;
  IF OLD."sale_id" IS NOT NULL AND NEW."sale_id" IS DISTINCT FROM OLD."sale_id" THEN
    RAISE EXCEPTION 'The sale of order % cannot be changed', OLD."number";
  END IF;
  IF OLD."deposit_refund_journal_id" IS NOT NULL AND NEW."deposit_refund_journal_id" IS DISTINCT FROM OLD."deposit_refund_journal_id" THEN
    RAISE EXCEPTION 'The deposit of order % has already been refunded', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;

-- ── Returns ─────────────────────────────────────────────────────────────────
ALTER TABLE "sale_returns"
  ADD CONSTRAINT "sale_returns_amounts_chk" CHECK (
    "net_amount" >= 0 AND "tax_amount" >= 0 AND "shipping_net" >= 0 AND "shipping_tax" >= 0 AND "cost_restocked" >= 0
    AND "total" = "net_amount" + "tax_amount" + "shipping_net" + "shipping_tax"
    AND "credited_to_account" >= 0 AND "paid_out" >= 0
  ),
  -- A completed return has refunded exactly its total and posted its journal.
  ADD CONSTRAINT "sale_returns_completed_chk" CHECK (
    "status" <> 'COMPLETED' OR ("credited_to_account" + "paid_out" = "total" AND "journal_entry_id" IS NOT NULL AND "completed_at" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "sale_returns_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Returns cannot be deleted';
  END IF;
  IF OLD."status"::text IN ('COMPLETED', 'REJECTED') THEN
    RAISE EXCEPTION 'Return % is % and final', OLD."number", OLD."status";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "sale_returns_guard_trg" BEFORE UPDATE OR DELETE ON "sale_returns"
  FOR EACH ROW EXECUTE FUNCTION "sale_returns_guard"();

ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_amounts_chk" CHECK (
  "qty" > 0 AND "net_amount" >= 0 AND "tax_amount" >= 0 AND "line_total" = "net_amount" + "tax_amount"
  AND "unit_cost" >= 0 AND "cost_amount" >= 0 AND (NOT "restock" OR "condition" = 'RESALEABLE')
);
CREATE TRIGGER "sale_return_items_append_only_trg" BEFORE UPDATE OR DELETE ON "sale_return_items"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();

-- ── Customer receipts ───────────────────────────────────────────────────────
ALTER TABLE "customer_receipts" ADD CONSTRAINT "customer_receipts_amounts_chk" CHECK ("amount" > 0 AND "unallocated" >= 0 AND "unallocated" <= "amount");
ALTER TABLE "customer_receipt_allocations" ADD CONSTRAINT "customer_receipt_allocations_amount_chk" CHECK ("amount" > 0);
CREATE TRIGGER "customer_receipts_append_only_trg" BEFORE UPDATE OR DELETE ON "customer_receipts"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
CREATE TRIGGER "customer_receipt_allocations_append_only_trg" BEFORE UPDATE OR DELETE ON "customer_receipt_allocations"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();

-- ── Expenses ────────────────────────────────────────────────────────────────
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_amounts_chk" CHECK (
  "net_amount" > 0 AND "tax_amount" >= 0 AND "total" = "net_amount" + "tax_amount"
  AND ("status" <> 'POSTED' OR ("journal_entry_id" IS NOT NULL AND "posted_at" IS NOT NULL))
);

CREATE OR REPLACE FUNCTION "expenses_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text = 'POSTED' THEN
    RAISE EXCEPTION 'Posted expense % cannot be changed or deleted', OLD."number";
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "expenses_guard_trg" BEFORE UPDATE OR DELETE ON "expenses"
  FOR EACH ROW EXECUTE FUNCTION "expenses_guard"();

CREATE OR REPLACE FUNCTION "expense_attachments_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "expenses" WHERE "id" = COALESCE(NEW."expense_id", OLD."expense_id");
  IF v_status = 'POSTED' THEN
    RAISE EXCEPTION 'Attachments of a posted expense cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "expense_attachments_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "expense_attachments"
  FOR EACH ROW EXECUTE FUNCTION "expense_attachments_guard"();

-- ── Bank reconciliation ─────────────────────────────────────────────────────
CREATE UNIQUE INDEX "bank_reconciliations_one_open_per_account" ON "bank_reconciliations" ("account_id") WHERE "status" = 'IN_PROGRESS';

CREATE OR REPLACE FUNCTION "bank_reconciliations_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status"::text = 'COMPLETED' THEN
    RAISE EXCEPTION 'A completed reconciliation is final';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "bank_reconciliations_guard_trg" BEFORE UPDATE OR DELETE ON "bank_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION "bank_reconciliations_guard"();

CREATE OR REPLACE FUNCTION "bank_reconciliation_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "bank_reconciliations" WHERE "id" = COALESCE(NEW."reconciliation_id", OLD."reconciliation_id");
  IF v_status = 'COMPLETED' THEN
    RAISE EXCEPTION 'Lines of a completed reconciliation cannot be changed';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "bank_reconciliation_lines_guard_trg" BEFORE INSERT OR UPDATE OR DELETE ON "bank_reconciliation_lines"
  FOR EACH ROW EXECUTE FUNCTION "bank_reconciliation_lines_guard"();
