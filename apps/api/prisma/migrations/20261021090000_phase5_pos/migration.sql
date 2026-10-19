-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('RETAIL', 'WHOLESALE');

-- CreateEnum
CREATE TYPE "PaymentMethodKind" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('SUSPENDED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "SaleChannel" AS ENUM ('POS', 'ONLINE');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomerType" NOT NULL DEFAULT 'RETAIL',
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "allow_credit" BOOLEAN NOT NULL DEFAULT false,
    "credit_limit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "PaymentMethodKind" NOT NULL,
    "account_id" UUID NOT NULL,
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "available_pos" BOOLEAN NOT NULL DEFAULT true,
    "available_online" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registers" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cashier_shifts" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "register_id" UUID NOT NULL,
    "cashier_id" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opening_float" DECIMAL(18,2) NOT NULL,
    "closed_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "expected_cash" DECIMAL(18,2),
    "counted_cash" DECIMAL(18,2),
    "variance" DECIMAL(18,2),
    "close_note" TEXT,
    "journal_entry_id" UUID,

    CONSTRAINT "cashier_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "number" TEXT,
    "channel" "SaleChannel" NOT NULL DEFAULT 'POS',
    "status" "SaleStatus" NOT NULL,
    "location_id" UUID NOT NULL,
    "register_id" UUID,
    "shift_id" UUID,
    "customer_id" UUID,
    "cashier_id" UUID NOT NULL,
    "prices_include_tax" BOOLEAN NOT NULL,
    "gross_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "amount_paid" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "change_given" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "cost_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discount_approved_by_id" UUID,
    "idempotency_key" TEXT,
    "journal_entry_id" UUID,
    "note" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "variant_id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(18,2) NOT NULL,
    "list_price" DECIMAL(18,2) NOT NULL,
    "discount_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "tax_rate_id" UUID,
    "tax_rate" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(18,2) NOT NULL,
    "tax_amount" DECIMAL(18,2) NOT NULL,
    "line_total" DECIMAL(18,2) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cost_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "qty_returned" DECIMAL(14,3) NOT NULL DEFAULT 0,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "tendered" DECIMAL(18,2),
    "change_given" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- CreateIndex
CREATE UNIQUE INDEX "registers_location_id_name_key" ON "registers"("location_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "cashier_shifts_number_key" ON "cashier_shifts"("number");

-- CreateIndex
CREATE INDEX "cashier_shifts_register_id_opened_at_idx" ON "cashier_shifts"("register_id", "opened_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_number_key" ON "sales"("number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_idempotency_key_key" ON "sales"("idempotency_key");

-- CreateIndex
CREATE INDEX "sales_status_completed_at_idx" ON "sales"("status", "completed_at");

-- CreateIndex
CREATE INDEX "sales_shift_id_idx" ON "sales"("shift_id");

-- CreateIndex
CREATE INDEX "sales_customer_id_idx" ON "sales"("customer_id");

-- CreateIndex
CREATE INDEX "sales_location_id_completed_at_idx" ON "sales"("location_id", "completed_at");

-- CreateIndex
CREATE INDEX "sale_items_variant_id_idx" ON "sale_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_sale_id_line_no_key" ON "sale_items"("sale_id", "line_no");

-- CreateIndex
CREATE INDEX "sale_payments_sale_id_idx" ON "sale_payments"("sale_id");

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registers" ADD CONSTRAINT "registers_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cashier_shifts" ADD CONSTRAINT "cashier_shifts_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "cashier_shifts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_discount_approved_by_id_fkey" FOREIGN KEY ("discount_approved_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_tax_rate_id_fkey" FOREIGN KEY ("tax_rate_id") REFERENCES "tax_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
