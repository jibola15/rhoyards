-- Phase 7 integrity guards (documented in docs/DATABASE.md).

-- ── Customer sign-in ────────────────────────────────────────────────────────
ALTER TABLE "customer_accounts"
  ADD CONSTRAINT "customer_accounts_email_lower_chk" CHECK ("email" = lower("email")),
  ADD CONSTRAINT "customer_accounts_failed_login_chk" CHECK ("failed_login_count" >= 0);

-- A session belongs to exactly one realm: staff sessions to a user, storefront sessions to a customer account.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_realm_owner_chk" CHECK (
  ("realm" = 'STAFF' AND "customer_account_id" IS NULL)
  OR ("realm" = 'CUSTOMER' AND "customer_account_id" IS NOT NULL AND "user_id" IS NULL)
);

-- ── Shipping ────────────────────────────────────────────────────────────────
ALTER TABLE "shipping_methods" ADD CONSTRAINT "shipping_methods_fee_chk" CHECK ("fee" >= 0 AND ("free_over" IS NULL OR "free_over" >= 0));

-- ── Orders ──────────────────────────────────────────────────────────────────
ALTER TABLE "online_orders"
  ADD CONSTRAINT "online_orders_amounts_chk" CHECK (
    "shipping_fee" >= 0 AND "shipping_net" >= 0 AND "shipping_tax" >= 0 AND "items_total" >= 0
    AND "subtotal" >= 0 AND "tax_total" >= 0 AND "total" >= 0
    AND "total" = "subtotal" + "tax_total"
    AND "shipping_fee" = CASE WHEN "prices_include_tax" THEN "shipping_net" + "shipping_tax" ELSE "shipping_net" END
  ),
  -- Delivery needs an address; store pickup does not.
  ADD CONSTRAINT "online_orders_address_chk" CHECK (
    "is_pickup" OR ("recipient" IS NOT NULL AND "phone" IS NOT NULL AND "line1" IS NOT NULL AND "city" IS NOT NULL AND "state" IS NOT NULL)
  ),
  -- Paid orders are backed by a sale; an order on hold by a customer deposit; only unpaid orders hold stock.
  ADD CONSTRAINT "online_orders_payment_chk" CHECK (
    ("status" IN ('PAID', 'PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED')) = ("sale_id" IS NOT NULL)
    AND ("status" <> 'ON_HOLD' OR "deposit_journal_id" IS NOT NULL)
    AND ("reservation_status" <> 'ACTIVE' OR "status" = 'PENDING_PAYMENT')
  );

-- Amounts and lines are fixed at checkout; cancelled and delivered orders are final; the sale link is permanent.
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
  IF OLD."status"::text IN ('CANCELLED', 'DELIVERED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Order % is % and cannot change status', OLD."number", OLD."status";
  END IF;
  IF OLD."sale_id" IS NOT NULL AND NEW."sale_id" IS DISTINCT FROM OLD."sale_id" THEN
    RAISE EXCEPTION 'The sale of order % cannot be changed', OLD."number";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "online_orders_guard_trg" BEFORE UPDATE OR DELETE ON "online_orders"
  FOR EACH ROW EXECUTE FUNCTION "online_orders_guard"();

ALTER TABLE "online_order_items" ADD CONSTRAINT "online_order_items_amounts_chk" CHECK (
  "qty" > 0 AND "unit_price" >= 0 AND "tax_rate" BETWEEN 0 AND 100
  AND "net_amount" >= 0 AND "tax_amount" >= 0 AND "line_total" = "net_amount" + "tax_amount"
);
CREATE TRIGGER "online_order_items_append_only_trg" BEFORE UPDATE OR DELETE ON "online_order_items"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();
CREATE TRIGGER "order_status_history_append_only_trg" BEFORE UPDATE OR DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION "forbid_update_delete"();

-- ── Payments ────────────────────────────────────────────────────────────────
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_amount_chk" CHECK ("amount" > 0);

-- A succeeded or failed attempt is final.
CREATE OR REPLACE FUNCTION "payment_attempts_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment attempts cannot be deleted';
  END IF;
  IF OLD."status"::text <> 'INITIATED' AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'Payment % is already %', OLD."reference", OLD."status";
  END IF;
  IF (NEW."order_id", NEW."provider", NEW."reference", NEW."amount") IS DISTINCT FROM (OLD."order_id", OLD."provider", OLD."reference", OLD."amount") THEN
    RAISE EXCEPTION 'Payment % cannot be altered', OLD."reference";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_attempts_guard_trg" BEFORE UPDATE OR DELETE ON "payment_attempts"
  FOR EACH ROW EXECUTE FUNCTION "payment_attempts_guard"();

-- Webhook events are evidence: only the processing outcome may be recorded after they are stored.
CREATE OR REPLACE FUNCTION "payment_webhook_events_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Webhook events cannot be deleted';
  END IF;
  IF (NEW."provider", NEW."event_id", NEW."signature_valid", NEW."payload", NEW."received_at")
     IS DISTINCT FROM (OLD."provider", OLD."event_id", OLD."signature_valid", OLD."payload", OLD."received_at") THEN
    RAISE EXCEPTION 'Webhook event % cannot be altered', OLD."event_id";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "payment_webhook_events_guard_trg" BEFORE UPDATE OR DELETE ON "payment_webhook_events"
  FOR EACH ROW EXECUTE FUNCTION "payment_webhook_events_guard"();

-- ── Sales ───────────────────────────────────────────────────────────────────
-- Online sales have no till or shift; only online sales carry delivery.
ALTER TABLE "sales" ADD CONSTRAINT "sales_channel_chk" CHECK (
  "shipping_amount" >= 0
  AND ("channel" = 'ONLINE' OR "shipping_amount" = 0)
  AND ("channel" = 'POS' OR ("register_id" IS NULL AND "shift_id" IS NULL))
);
