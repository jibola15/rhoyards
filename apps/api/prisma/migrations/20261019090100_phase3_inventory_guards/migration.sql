-- Phase 3 integrity guards (documented in docs/DATABASE.md).

-- ── Catalogue ────────────────────────────────────────────────────────────────

ALTER TABLE "products"
  ADD CONSTRAINT "products_expiry_needs_batch_chk" CHECK (NOT "is_expiry_tracked" OR "is_batch_tracked");

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_sku_chk" CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
  ADD CONSTRAINT "product_variants_prices_chk" CHECK (
    "selling_price" >= 0
    AND ("compare_at_price" IS NULL OR "compare_at_price" >= 0)
    AND ("standard_cost" IS NULL OR "standard_cost" >= 0)
    AND "avg_cost" >= 0
  ),
  ADD CONSTRAINT "product_variants_reorder_chk" CHECK ("reorder_level" >= 0 AND "reorder_qty" >= 0);

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_terms_chk" CHECK ("payment_terms_days" BETWEEN 0 AND 365);

-- ── Inventory ────────────────────────────────────────────────────────────────

-- qty_on_hand may go below zero only through the explicitly authorised negative-stock path; reservations never.
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_reserved_chk" CHECK ("qty_reserved" >= 0);
-- A lot can never hold negative stock.
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_qty_chk" CHECK ("qty_on_hand" >= 0);

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_qty_chk" CHECK ("qty_change" <> 0),
  ADD CONSTRAINT "stock_movements_cost_chk" CHECK ("unit_cost" >= 0);

ALTER TABLE "stock_adjustment_lines"
  ADD CONSTRAINT "stock_adjustment_lines_qty_chk" CHECK ("qty_change" <> 0),
  ADD CONSTRAINT "stock_adjustment_lines_cost_chk" CHECK ("unit_cost" IS NULL OR "unit_cost" >= 0);

ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_qty_chk" CHECK ("qty" > 0);
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_locations_chk" CHECK ("from_location_id" <> "to_location_id");

-- The stock ledger is append-only (function defined in the Phase 2 guards migration).
CREATE TRIGGER "stock_movements_append_only_trg"
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();

-- ── Finalised documents are immutable ───────────────────────────────────────

CREATE OR REPLACE FUNCTION "stock_documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status"::text <> 'DRAFT' THEN
      RAISE EXCEPTION '% % is % and cannot be deleted', TG_TABLE_NAME, OLD."number", OLD."status";
    END IF;
    RETURN OLD;
  END IF;
  -- Final states: nothing may change afterwards.
  IF OLD."status"::text IN ('POSTED', 'RECEIVED', 'CANCELLED') THEN
    RAISE EXCEPTION '% % is % and cannot be changed', TG_TABLE_NAME, OLD."number", OLD."status";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "stock_adjustments_guard_trg"
  BEFORE UPDATE OR DELETE ON "stock_adjustments"
  FOR EACH ROW EXECUTE FUNCTION "stock_documents_guard"();

CREATE TRIGGER "stock_transfers_guard_trg"
  BEFORE UPDATE OR DELETE ON "stock_transfers"
  FOR EACH ROW EXECUTE FUNCTION "stock_documents_guard"();

-- Lines may change only while their document is a draft.
CREATE OR REPLACE FUNCTION "stock_adjustment_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "stock_adjustments"
    WHERE "id" = COALESCE(NEW."adjustment_id", OLD."adjustment_id") FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a % stock adjustment cannot be changed', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "stock_adjustment_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_adjustment_lines"
  FOR EACH ROW EXECUTE FUNCTION "stock_adjustment_lines_guard"();

-- Transfer lines: editable while DRAFT; batch allocations are written once at dispatch.
CREATE OR REPLACE FUNCTION "stock_transfer_lines_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT "status"::text INTO v_status FROM "stock_transfers"
    WHERE "id" = COALESCE(NEW."transfer_id", OLD."transfer_id") FOR SHARE;
  IF v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Lines of a % stock transfer cannot be changed', v_status;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "stock_transfer_lines_guard_trg"
  BEFORE INSERT OR UPDATE OR DELETE ON "stock_transfer_lines"
  FOR EACH ROW EXECUTE FUNCTION "stock_transfer_lines_guard"();
