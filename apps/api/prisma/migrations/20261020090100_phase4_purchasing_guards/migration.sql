-- Phase 4 integrity guards (documented in docs/DATABASE.md).

-- ── CHECK constraints ────────────────────────────────────────────────────────

ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "po_lines_qty_chk" CHECK ("qty_ordered" > 0 AND "qty_received" >= 0 AND "qty_received" <= "qty_ordered"),
  ADD CONSTRAINT "po_lines_cost_chk" CHECK ("unit_cost" >= 0 AND "tax_rate" BETWEEN 0 AND 100);

ALTER TABLE "goods_receipt_lines"
  ADD CONSTRAINT "grn_lines_qty_chk" CHECK ("qty" > 0 AND "unit_cost" >= 0 AND "tax_rate" BETWEEN 0 AND 100),
  ADD CONSTRAINT "grn_lines_matching_chk" CHECK (
    "qty_invoiced" >= 0 AND "qty_returned_uninvoiced" >= 0 AND "qty_returned_invoiced" >= 0
    AND "qty_invoiced" + "qty_returned_uninvoiced" <= "qty"
    AND "qty_returned_invoiced" <= "qty_invoiced"
    AND "value" >= 0 AND "grni_cleared" >= 0 AND "grni_cleared" <= "value"
  );

ALTER TABLE "supplier_invoices"
  ADD CONSTRAINT "supplier_invoices_amounts_chk" CHECK ("total" >= 0 AND "amount_paid" >= 0 AND "amount_paid" <= "total"),
  ADD CONSTRAINT "supplier_invoices_dates_chk" CHECK ("due_date" >= "invoice_date");

ALTER TABLE "supplier_invoice_lines"
  ADD CONSTRAINT "supplier_invoice_lines_qty_chk" CHECK ("qty" > 0 AND "unit_cost" >= 0 AND "tax_rate" BETWEEN 0 AND 100),
  -- A line either matches received goods or charges an account — never both, never neither.
  ADD CONSTRAINT "supplier_invoice_lines_target_chk" CHECK (("grn_line_id" IS NULL) <> ("account_id" IS NULL));

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_chk" CHECK ("amount" > 0 AND "unallocated" >= 0 AND "unallocated" <= "amount");
ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_amount_chk" CHECK ("amount" > 0);

ALTER TABLE "purchase_return_lines" ADD CONSTRAINT "purchase_return_lines_qty_chk" CHECK ("qty" > 0);

-- ── Payments are immutable records ──────────────────────────────────────────

CREATE TRIGGER "supplier_payments_append_only_trg"
  BEFORE UPDATE OR DELETE ON "supplier_payments"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
CREATE TRIGGER "supplier_payment_allocations_append_only_trg"
  BEFORE UPDATE OR DELETE ON "supplier_payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();

-- ── Goods receipts and purchase returns: final once posted/cancelled ───────
-- (stock_documents_guard is defined in the Phase 3 guards migration.)

CREATE TRIGGER "goods_receipts_guard_trg"
  BEFORE UPDATE OR DELETE ON "goods_receipts"
  FOR EACH ROW EXECUTE FUNCTION "stock_documents_guard"();
CREATE TRIGGER "purchase_returns_guard_trg"
  BEFORE UPDATE OR DELETE ON "purchase_returns"
  FOR EACH ROW EXECUTE FUNCTION "stock_documents_guard"();

-- Receipt lines: free while DRAFT. Afterwards only the matching counters may change.
CREATE OR REPLACE FUNCTION "goods_receipt_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "goods_receipts"
    WHERE "id" = COALESCE(NEW."receipt_id", OLD."receipt_id") FOR SHARE;
  IF v_status = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Lines of a % goods receipt cannot be added or removed', v_status;
  END IF;
  IF (NEW."receipt_id", NEW."line_no", NEW."po_line_id", NEW."variant_id", NEW."qty", NEW."unit_cost", NEW."tax_rate_id",
      NEW."tax_rate", NEW."lot_number", NEW."mfg_date", NEW."expiry_date", NEW."value")
     IS DISTINCT FROM
     (OLD."receipt_id", OLD."line_no", OLD."po_line_id", OLD."variant_id", OLD."qty", OLD."unit_cost", OLD."tax_rate_id",
      OLD."tax_rate", OLD."lot_number", OLD."mfg_date", OLD."expiry_date", OLD."value") THEN
    RAISE EXCEPTION 'Received quantity, cost and lot of a posted goods receipt cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "goods_receipt_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "goods_receipt_lines"
  FOR EACH ROW EXECUTE FUNCTION "goods_receipt_lines_guard"();

-- Return lines: DRAFT only.
CREATE OR REPLACE FUNCTION "purchase_return_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "purchase_returns"
    WHERE "id" = COALESCE(NEW."return_id", OLD."return_id") FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a % purchase return cannot be changed', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "purchase_return_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_return_lines"
  FOR EACH ROW EXECUTE FUNCTION "purchase_return_lines_guard"();

-- ── Purchase orders: commercial terms fixed once approved ──────────────────

CREATE OR REPLACE FUNCTION "purchase_orders_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'Purchase order % is % and cannot be deleted', OLD."number", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status"::text IN ('RECEIVED', 'CLOSED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Purchase order % is % and cannot be changed', OLD."number", OLD."status";
  END IF;
  IF OLD."status"::text <> 'DRAFT' AND
     (NEW."supplier_id", NEW."location_id", NEW."order_date", NEW."subtotal", NEW."tax_total", NEW."total")
     IS DISTINCT FROM
     (OLD."supplier_id", OLD."location_id", OLD."order_date", OLD."subtotal", OLD."tax_total", OLD."total") THEN
    RAISE EXCEPTION 'Purchase order % is approved; its supplier, location and amounts are fixed', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_orders_guard_trg"
  BEFORE UPDATE OR DELETE ON "purchase_orders"
  FOR EACH ROW EXECUTE FUNCTION "purchase_orders_guard"();

-- Order lines: free while DRAFT; afterwards only qty_received changes (from posted receipts).
CREATE OR REPLACE FUNCTION "purchase_order_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "purchase_orders"
    WHERE "id" = COALESCE(NEW."po_id", OLD."po_id") FOR SHARE;
  IF v_status = 'DRAFT' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'Lines of a % purchase order cannot be added or removed', v_status;
  END IF;
  IF (NEW."po_id", NEW."line_no", NEW."variant_id", NEW."qty_ordered", NEW."unit_cost", NEW."tax_rate_id", NEW."tax_rate", NEW."net_amount")
     IS DISTINCT FROM
     (OLD."po_id", OLD."line_no", OLD."variant_id", OLD."qty_ordered", OLD."unit_cost", OLD."tax_rate_id", OLD."tax_rate", OLD."net_amount") THEN
    RAISE EXCEPTION 'Lines of an approved purchase order cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "purchase_order_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_lines"
  FOR EACH ROW EXECUTE FUNCTION "purchase_order_lines_guard"();

-- ── Supplier invoices: once posted, only payment progress changes ──────────

CREATE OR REPLACE FUNCTION "supplier_invoices_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION 'Supplier invoice % is % and cannot be deleted', OLD."number", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status"::text IN ('PAID', 'CANCELLED') THEN
    RAISE EXCEPTION 'Supplier invoice % is % and cannot be changed', OLD."number", OLD."status";
  END IF;
  IF OLD."status"::text <> 'DRAFT' AND
     (NEW."supplier_id", NEW."supplier_ref", NEW."invoice_date", NEW."due_date", NEW."subtotal", NEW."tax_total", NEW."total", NEW."journal_entry_id")
     IS DISTINCT FROM
     (OLD."supplier_id", OLD."supplier_ref", OLD."invoice_date", OLD."due_date", OLD."subtotal", OLD."tax_total", OLD."total", OLD."journal_entry_id") THEN
    RAISE EXCEPTION 'Supplier invoice % is posted; only payments can change it', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "supplier_invoices_guard_trg"
  BEFORE UPDATE OR DELETE ON "supplier_invoices"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoices_guard"();

CREATE OR REPLACE FUNCTION "supplier_invoice_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "supplier_invoices"
    WHERE "id" = COALESCE(NEW."invoice_id", OLD."invoice_id") FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a % supplier invoice cannot be changed', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
CREATE TRIGGER "supplier_invoice_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "supplier_invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION "supplier_invoice_lines_guard"();
